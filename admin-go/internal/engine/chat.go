// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/lsegroup/mnemosyne/admin-go/internal/jobs"
	"github.com/lsegroup/mnemosyne/admin-go/internal/llm"
	"github.com/lsegroup/mnemosyne/admin-go/internal/store"
)

// LLM CALL - chat completion. *** COSTS MONEY ***
// The provider and model are the ones an administrator assigned to the "Text" job in Admin -> LLM. Called only by the documentation
// generator: by the Auto scheduler after an administrator agreed to a setup, or (in the Node server) after a person pressed a button
// and confirmed the cost. Nothing else calls a model. Every call reports its token usage.

// ChatResult is what the provider answered and what it says it used.
type ChatResult struct {
	Text         string
	InputTokens  int
	OutputTokens int
	// ReasoningTokens are the output tokens the provider says were spent thinking; nil when it does not report them.
	ReasoningTokens *int
}

// ChatOptions are the limits of one call; nil sampling values are not sent (the provider's default applies).
type ChatOptions struct {
	MaxTokens       int
	Timeout         time.Duration
	Temperature     *float64
	TopP            *float64
	ReasoningEffort string
}

// UnreachableError is a failed connection (DNS, reset, closed, refused): the request never arrived, so nothing was billed and it is safe
// to send again.
type UnreachableError struct{ Msg string }

func (e *UnreachableError) Error() string { return e.Msg }

// sleep is replaced in tests.
var sleep = time.Sleep

const defaultTimeout = 20 * time.Minute

// networkDetail is the technical reason of a failed connection, e.g. "connection refused". Never contains secrets.
func networkDetail(err error) string {
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "timed out"
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return dns.Err
	}
	for {
		next := errors.Unwrap(err)
		if next == nil {
			break
		}
		err = next
	}
	return err.Error()
}

// retryStatus is an answer that says the provider (not the request) has a problem right now: overloaded (429) or failing (500, 502, 503, 504).
// Such an answer is not billed, so the same request is sent again after a pause.
func retryStatus(code int) bool {
	return code == http.StatusTooManyRequests || code == http.StatusInternalServerError || code == http.StatusBadGateway ||
		code == http.StatusServiceUnavailable || code == http.StatusGatewayTimeout
}

// retryPause is the pause before try number n+1 (n = 0, 1, 2): 1.5 s, 3 s, 6 s - exponential backoff.
func retryPause(n int) time.Duration { return time.Duration(1500*(1<<n)) * time.Millisecond }

// sendTries is how many times a request is sent in all.
const sendTries = 4

// postWithRetry sends the request, up to three more times with exponential backoff when the connection itself fails (DNS, refused, reset) or the
// provider answers 429 or 5xx. A timeout is not retried: the request may have reached the provider and been billed.
func postWithRetry(url string, headers map[string]string, body []byte, timeout time.Duration, what string) (*http.Response, error) {
	detail := ""
	for attempt := 0; attempt < sendTries; attempt++ {
		req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		client := llm.Client(timeout)
		// every call opens its own connection, so a fixed address that was changed or removed applies to the very next call
		client.Transport.(*http.Transport).DisableKeepAlives = true
		res, err := client.Do(req)
		if err == nil {
			if retryStatus(res.StatusCode) && attempt < sendTries-1 {
				res.Body.Close()
				sleep(retryPause(attempt))
				continue
			}
			return res, nil
		}
		detail = networkDetail(err)
		if detail == "timed out" {
			break
		}
		if attempt < sendTries-1 {
			sleep(retryPause(attempt))
		}
	}
	msg := fmt.Sprintf("Could not reach %s (%s).", what, detail)
	// a timeout may have reached the provider and been billed; a connection that never opened was not
	if detail == "timed out" {
		return nil, jobs.Invalid("%s", msg)
	}
	return nil, &UnreachableError{Msg: msg}
}

var versionSuffix = regexp.MustCompile(`/v\d+$`)

func endpoint(p store.Provider) string {
	base := strings.TrimRight(p.BaseURL, "/")
	if p.Kind == store.AnthropicMessages {
		if versionSuffix.MatchString(base) {
			return base + "/messages"
		}
		return base + "/v1/messages"
	}
	return base + "/chat/completions"
}

var reMessage = regexp.MustCompile(`"message"\s*:\s*"([^"]{1,200})`)

type chatAnswer struct {
	Choices []struct {
		Message struct {
			Content          any `json:"content"`
			ReasoningContent any `json:"reasoning_content"`
			Reasoning        any `json:"reasoning"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	StopReason string `json:"stop_reason"`
	Content    []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	Usage struct {
		PromptTokens     *int `json:"prompt_tokens"`
		CompletionTokens *int `json:"completion_tokens"`
		InputTokens      *int `json:"input_tokens"`
		OutputTokens     *int `json:"output_tokens"`
		CompletionDetail *struct {
			ReasoningTokens *int `json:"reasoning_tokens"`
		} `json:"completion_tokens_details"`
		OutputDetail *struct {
			ReasoningTokens *int `json:"reasoning_tokens"`
		} `json:"output_tokens_details"`
	} `json:"usage"`
}

func intOr(a, b *int) int {
	switch {
	case a != nil:
		return *a
	case b != nil:
		return *b
	}
	return 0
}

// Chat makes ONE call to the provider: a system prompt and a user prompt, one answer.
func Chat(p store.Provider, model, system, user string, opts ChatOptions) (ChatResult, error) {
	maxTokens := opts.MaxTokens
	if maxTokens == 0 {
		maxTokens = 8000
	}
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = defaultTimeout
	}
	headers := map[string]string{"Content-Type": "application/json", "Accept": "application/json", "Authorization": "Bearer " + p.APIKey}
	if p.Kind == store.AnthropicMessages {
		headers["x-api-key"] = p.APIKey
		headers["anthropic-version"] = "2023-06-01"
	}
	send := func(limitField string, limit int) (*http.Response, error) {
		body := map[string]any{"model": model}
		// temperature / top_p are sent only when an administrator set them; the reasoning effort exists in the OpenAI-style format only
		if opts.Temperature != nil {
			body["temperature"] = *opts.Temperature
		}
		if opts.TopP != nil {
			body["top_p"] = *opts.TopP
		}
		if p.Kind == store.AnthropicMessages {
			body["system"] = system
			body["max_tokens"] = limit
			body["messages"] = []any{map[string]any{"role": "user", "content": user}}
		} else {
			body[limitField] = limit
			if opts.ReasoningEffort != "" {
				body["reasoning_effort"] = opts.ReasoningEffort
			}
			body["messages"] = []any{map[string]any{"role": "system", "content": system}, map[string]any{"role": "user", "content": user}}
		}
		raw, _ := json.Marshal(body)
		return postWithRetry(endpoint(p), headers, raw, timeout, "the provider")
	}

	// A 400 is not billed. Try the other field name (some OpenAI-style APIs only know the newer one) and, for very large limits, a
	// smaller limit in case the model's maximum output is lower than asked.
	type attempt struct {
		field string
		limit int
	}
	attempts := []attempt{{"max_tokens", maxTokens}, {"max_completion_tokens", maxTokens}}
	if maxTokens > 16_000 {
		attempts = append(attempts, attempt{"max_tokens", 16_000}, attempt{"max_completion_tokens", 16_000})
	}
	var res *http.Response
	usedLimit, why := maxTokens, ""
	for _, a := range attempts {
		var err error
		if res != nil {
			res.Body.Close()
		}
		res, err = send(a.field, a.limit)
		if err != nil {
			return ChatResult{}, err
		}
		usedLimit = a.limit
		if res.StatusCode != http.StatusBadRequest {
			break
		}
		text, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		if m := reMessage.FindSubmatch(text); m != nil {
			why = strings.TrimSpace(string(m[1]))
		} else {
			why = ""
		}
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode == http.StatusBadRequest:
		sent := ""
		if opts.ReasoningEffort != "" && p.Kind != store.AnthropicMessages {
			sent = fmt.Sprintf(` This job sends the reasoning effort "%s"; if the model does not support it, set it back to "Provider default" in Admin → LLM.`, opts.ReasoningEffort)
		}
		detail := ""
		if why != "" {
			detail = ": " + why
		}
		return ChatResult{}, jobs.Invalid("The provider rejected the request (HTTP 400%s).%s", detail, sent)
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return ChatResult{}, jobs.Invalid("The provider rejected the API key (HTTP %d).", res.StatusCode)
	case res.StatusCode == http.StatusTooManyRequests:
		return ChatResult{}, jobs.Invalid("The provider is rate-limiting this key (HTTP 429). Try again in a minute.")
	case res.StatusCode < 200 || res.StatusCode > 299:
		return ChatResult{}, jobs.Invalid("The provider answered HTTP %d.", res.StatusCode)
	}

	var ans chatAnswer
	raw, _ := io.ReadAll(res.Body)
	_ = json.Unmarshal(raw, &ans)
	content := ""
	if len(ans.Choices) > 0 {
		if s, ok := ans.Choices[0].Message.Content.(string); ok {
			content = s
		}
	}
	if content == "" {
		var b strings.Builder
		for _, c := range ans.Content {
			if c.Type == "text" || c.Text != "" {
				b.WriteString(c.Text)
			}
		}
		content = b.String()
	}
	if JSTrim(content) == "" {
		// Reasoning models spend part of the limit on thinking; with a small limit nothing is left for the answer.
		finish := ans.StopReason
		if len(ans.Choices) > 0 && ans.Choices[0].FinishReason != "" {
			finish = ans.Choices[0].FinishReason
		}
		if finish == "" {
			finish = "unknown"
		}
		out := intOr(ans.Usage.CompletionTokens, ans.Usage.OutputTokens)
		thought := len(ans.Choices) > 0 && (ans.Choices[0].Message.ReasoningContent != nil || ans.Choices[0].Message.Reasoning != nil)
		only := ""
		if thought {
			only = ", the model only produced reasoning"
		}
		tail := "Try again or choose another model in Admin → LLM."
		if finish == "length" || finish == "max_tokens" {
			tail = fmt.Sprintf("The limit of %d tokens was used up before the answer - it needs a higher limit.", usedLimit)
		}
		return ChatResult{}, jobs.Invalid("The provider returned no text (finish reason: %s, %d output tokens%s). %s", finish, out, only, tail)
	}
	r := ChatResult{Text: content, InputTokens: intOr(ans.Usage.PromptTokens, ans.Usage.InputTokens), OutputTokens: intOr(ans.Usage.CompletionTokens, ans.Usage.OutputTokens)}
	if d := ans.Usage.CompletionDetail; d != nil && d.ReasoningTokens != nil {
		r.ReasoningTokens = d.ReasoningTokens
	} else if d := ans.Usage.OutputDetail; d != nil && d.ReasoningTokens != nil {
		r.ReasoningTokens = d.ReasoningTokens
	}
	return r, nil
}

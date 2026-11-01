// Package config reads the same environment the Node server reads (same variable names, same defaults), so the Go admin
// can be started with the environment file the service already has. A few variables are new and only belong to Go.
package config

import (
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// GitLab is the SSO application; values saved in the admin page win over these (see store.Settings).
type GitLab struct {
	URL          string
	ClientID     string
	ClientSecret string
}

// LocalAdmin is the built-in admin account that lets the portal be configured before GitLab SSO exists.
type LocalAdmin struct {
	User         string
	PasswordHash string
	Password     string
}

// Config is everything the admin needs to know at start-up.
type Config struct {
	RepoDir  string
	NodesDir string
	DBPath   string
	// BasePath is the path prefix every route lives under ("/mnemosyne"; "" for none).
	BasePath string

	Secret     string
	PublicURL  string
	AliasHosts []string
	GitLab     GitLab
	LocalAdmin LocalAdmin
	// LocalAdminForce is the recovery switch: the built-in account keeps working although SSO is live.
	LocalAdminForce bool

	ProvidersFile string
	SettingsFile  string
	MembersFile   string
	TokensFile    string
	AuditFile     string
	UsageFile     string
	DocsDir       string
	AutoFile      string
	AIDailyLimit  int

	// The licence: its sealed state file, the licence server, and a key given in the environment (taken up once, when none is stored).
	LicenseFile   string
	LicenseServer string
	LicenseKey    string
	// LicenseDomain is the domain this installation is licensed for (the licence server shows it); empty = the host of the public URL.
	LicenseDomain string
	// Version is the version of this program (set by main).
	Version string

	// Listen is where the Go admin listens (in front of the Node server); Upstream is the Node server behind it.
	Listen   string
	Upstream string
}

var truthy = regexp.MustCompile(`(?i)^(1|true|yes|on)$`)

func boolOf(v string) bool { return truthy.MatchString(v) }

func intOf(v string, dflt int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
		return n
	}
	return dflt
}

// NormalizeBasePath makes "/x/", "x" and "/x" the same "/x"; "" and "/" mean no prefix.
func NormalizeBasePath(v string) string {
	t := strings.TrimRight(strings.TrimSpace(v), "/")
	if t == "" {
		return ""
	}
	if !strings.HasPrefix(t, "/") {
		return "/" + t
	}
	return t
}

// Load builds the config from an environment lookup (os.Getenv in production) and the working directory.
func Load(get func(string) string, cwd string) (Config, error) {
	repo := get("MNEMOSYNE_REPO")
	if repo == "" {
		repo = cwd
	}
	repo, err := filepath.Abs(repo)
	if err != nil {
		return Config{}, err
	}
	pick := func(name, dflt string) string {
		if v := get(name); v != "" {
			return v
		}
		return dflt
	}
	nodes := pick("MNEMOSYNE_NODES_DIR", "nodes")
	if !filepath.IsAbs(nodes) {
		nodes = filepath.Join(repo, nodes)
	}
	db := pick("MNEMOSYNE_DB", filepath.Join(repo, ".mnemosyne", "index.db"))
	db, err = filepath.Abs(db)
	if err != nil {
		return Config{}, err
	}
	data := filepath.Dir(db)
	file := func(name, dflt string) string {
		p := pick(name, filepath.Join(data, dflt))
		abs, err := filepath.Abs(p)
		if err != nil {
			return p
		}
		return abs
	}
	alias := []string{}
	for _, h := range regexp.MustCompile(`[\s,]+`).Split(get("MNEMOSYNE_ALIAS_HOSTS"), -1) {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			alias = append(alias, h)
		}
	}
	return Config{
		RepoDir:  repo,
		NodesDir: filepath.Clean(nodes),
		DBPath:   db,
		BasePath: NormalizeBasePath(pick("MNEMOSYNE_BASE_PATH", "/mnemosyne")),

		Secret:     get("MNEMOSYNE_SECRET"),
		PublicURL:  strings.TrimRight(get("MNEMOSYNE_PUBLIC_URL"), "/"),
		AliasHosts: alias,
		GitLab: GitLab{
			URL:          strings.TrimRight(get("MNEMOSYNE_GITLAB_URL"), "/"),
			ClientID:     get("MNEMOSYNE_GITLAB_CLIENT_ID"),
			ClientSecret: get("MNEMOSYNE_GITLAB_CLIENT_SECRET"),
		},
		LocalAdmin: LocalAdmin{
			User:         get("MNEMOSYNE_LOCAL_ADMIN_USER"),
			PasswordHash: get("MNEMOSYNE_LOCAL_ADMIN_PASSWORD_HASH"),
			Password:     get("MNEMOSYNE_LOCAL_ADMIN_PASSWORD"),
		},
		LocalAdminForce: boolOf(get("MNEMOSYNE_LOCAL_ADMIN_FORCE")),

		ProvidersFile: file("MNEMOSYNE_PROVIDERS_FILE", "providers.enc"),
		SettingsFile:  file("MNEMOSYNE_SETTINGS_FILE", "settings.enc"),
		MembersFile:   file("MNEMOSYNE_MEMBERS_FILE", "members.enc"),
		TokensFile:    file("MNEMOSYNE_TOKENS_FILE", "tokens.enc"),
		AuditFile:     file("MNEMOSYNE_AUDIT_FILE", "audit.jsonl"),
		UsageFile:     file("MNEMOSYNE_USAGE_FILE", "usage.jsonl"),
		DocsDir:       file("MNEMOSYNE_DOCS_DIR", "docs"),
		AutoFile:      file("MNEMOSYNE_AUTO_FILE", "auto.json"),
		AIDailyLimit:  intOf(get("MNEMOSYNE_AI_DAILY_LIMIT"), 20),

		LicenseFile:   file("MNEMOSYNE_LICENSE_FILE", "license.enc"),
		LicenseServer: strings.TrimRight(get("MNEMOSYNE_LICENSE_SERVER"), "/"),
		LicenseKey:    strings.TrimSpace(get("MNEMOSYNE_LICENSE_KEY")),
		LicenseDomain: licenseDomain(get("MNEMOSYNE_LICENSE_DOMAIN")),

		Listen:   pick("MNEMOSYNE_ADMIN_LISTEN", "127.0.0.1:40001"),
		Upstream: strings.TrimRight(pick("MNEMOSYNE_UPSTREAM", "http://127.0.0.1:40002"), "/"),
	}, nil
}

// licenseDomain makes "https://Lumanet.INFO:40000/x" and " lumanet.info " the same "lumanet.info".
func licenseDomain(v string) string {
	v = strings.ToLower(strings.TrimSpace(v))
	if i := strings.Index(v, "://"); i >= 0 {
		v = v[i+3:]
	}
	if i := strings.IndexAny(v, "/:"); i >= 0 {
		v = v[:i]
	}
	return v
}

// Configured reports whether the portal can be switched on: a long enough secret and a public URL.
func (c Config) Configured() bool {
	if len(c.Secret) < 16 || c.PublicURL == "" {
		return false
	}
	_, err := url.Parse(c.PublicURL)
	return err == nil
}

// Getenv is os.Getenv, for main.
func Getenv(name string) string { return os.Getenv(name) }

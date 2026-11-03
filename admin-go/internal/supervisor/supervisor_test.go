// SPDX-License-Identifier: Apache-2.0

package supervisor

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func alive(pid int) bool { return pid > 0 && syscall.Kill(pid, 0) == nil }

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if ok() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestTheChildIsStartedWithTheEnvironmentAndStartedAgainWhenItDies(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "starts")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := Start(ctx, Spec{
		Command: []string{"sh", "-c", `echo "$MNEMOSYNE_ADMIN_EXTERNAL $$" >> ` + log + `; exec sleep 30`},
		Env:     []string{"MNEMOSYNE_ADMIN_EXTERNAL=1"},
		Pause:   20 * time.Millisecond, MaxPause: 40 * time.Millisecond,
	})
	waitFor(t, "the first start", func() bool { return s.PID() > 0 })
	first := s.PID()
	if err := syscall.Kill(first, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the restart", func() bool { return s.PID() > 0 && s.PID() != first })
	// the new shell writes its line a moment after it exists
	waitFor(t, "the second start to be written", func() bool {
		raw, _ := os.ReadFile(log)
		return len(strings.Fields(string(raw))) >= 4
	})
	raw, _ := os.ReadFile(log)
	lines := strings.Fields(string(raw))
	if len(lines) < 4 || lines[0] != "1" || lines[2] != "1" {
		t.Errorf("the child sees the environment on every start: %q", raw)
	}
	if lines[1] != strconv.Itoa(first) {
		t.Errorf("first pid %v, supervisor said %d", lines[1], first)
	}
	cancel()
	s.Wait()
}

func TestTheChildEndsWithTheSupervisor(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	s := Start(ctx, Spec{Command: []string{"sleep", "60"}})
	waitFor(t, "the start", func() bool { return s.PID() > 0 })
	pid := s.PID()
	if !alive(pid) {
		t.Fatal("the child is running")
	}
	cancel()
	s.Wait()
	waitFor(t, "the child to be gone", func() bool { return !alive(pid) })
}

func TestAProgramThatCannotBeStartedIsRetriedWithoutSpinning(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	s := Start(ctx, Spec{Command: []string{"/nonexistent/program"}, Pause: 20 * time.Millisecond, MaxPause: 40 * time.Millisecond})
	s.Wait()
	if s.PID() != 0 {
		t.Error("no child")
	}
}

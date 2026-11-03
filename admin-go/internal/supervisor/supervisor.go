// SPDX-License-Identifier: Apache-2.0

// Package supervisor starts the Node server of Mnemosyne as a child of the Go admin and keeps it running: when it dies it is started
// again (with a growing pause), and when the Go program ends the child ends with it. Without the Go program there is no Mnemosyne.
package supervisor

import (
	"context"
	"log"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// Spec says what to run.
type Spec struct {
	// Command is the program and its arguments, e.g. ["/usr/bin/node", "packages/server/dist/bin/mnemosyne.js", "serve", "--http"].
	Command []string
	// Env is added to the environment of this program.
	Env []string
	Dir string
	// Pause is the first pause before a restart (it doubles up to MaxPause); zero means one second.
	Pause    time.Duration
	MaxPause time.Duration
	// Healthy is how long a run must last before the pause starts from the beginning again.
	Healthy time.Duration
	Stdout  *os.File
	Stderr  *os.File
}

// Supervisor runs one child.
type Supervisor struct {
	spec Spec
	mu   sync.Mutex
	pid  int
	done chan struct{}
}

// Start runs the child until ctx ends. It returns at once; Wait blocks until the child is gone.
func Start(ctx context.Context, spec Spec) *Supervisor {
	if spec.Pause == 0 {
		spec.Pause = time.Second
	}
	if spec.MaxPause == 0 {
		spec.MaxPause = 30 * time.Second
	}
	if spec.Healthy == 0 {
		spec.Healthy = time.Minute
	}
	if spec.Stdout == nil {
		spec.Stdout = os.Stdout
	}
	if spec.Stderr == nil {
		spec.Stderr = os.Stderr
	}
	s := &Supervisor{spec: spec, done: make(chan struct{})}
	go s.loop(ctx)
	return s
}

// PID is the process id of the running child, or 0.
func (s *Supervisor) PID() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pid
}

// Wait blocks until the supervisor has stopped the child for good.
func (s *Supervisor) Wait() { <-s.done }

func (s *Supervisor) setPID(pid int) {
	s.mu.Lock()
	s.pid = pid
	s.mu.Unlock()
}

func (s *Supervisor) loop(ctx context.Context) {
	defer close(s.done)
	pause := s.spec.Pause
	for ctx.Err() == nil {
		cmd := exec.Command(s.spec.Command[0], s.spec.Command[1:]...)
		cmd.Env = append(os.Environ(), s.spec.Env...)
		cmd.Dir = s.spec.Dir
		cmd.Stdout, cmd.Stderr = s.spec.Stdout, s.spec.Stderr
		bindToParent(cmd)
		started := time.Now()
		if err := cmd.Start(); err != nil {
			log.Printf("supervisor: could not start %s: %v", s.spec.Command[0], err)
		} else {
			s.setPID(cmd.Process.Pid)
			log.Printf("supervisor: started %s (pid %d)", s.spec.Command[0], cmd.Process.Pid)
			exited := make(chan error, 1)
			go func() { exited <- cmd.Wait() }()
			select {
			case err := <-exited:
				log.Printf("supervisor: %s ended: %v", s.spec.Command[0], err)
			case <-ctx.Done():
				_ = cmd.Process.Signal(syscall.SIGTERM)
				select {
				case <-exited:
				case <-time.After(10 * time.Second):
					_ = cmd.Process.Kill()
					<-exited
				}
				s.setPID(0)
				return
			}
			s.setPID(0)
			if time.Since(started) >= s.spec.Healthy {
				pause = s.spec.Pause
			}
		}
		select {
		case <-time.After(pause):
		case <-ctx.Done():
			return
		}
		if pause *= 2; pause > s.spec.MaxPause {
			pause = s.spec.MaxPause
		}
	}
}

// SPDX-License-Identifier: Apache-2.0

//go:build linux

package supervisor

import (
	"os/exec"
	"syscall"
)

// bindToParent makes the kernel kill the child when this program dies, however it dies.
func bindToParent(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}

//go:build !linux

package supervisor

import "os/exec"

func bindToParent(*exec.Cmd) {}

// SPDX-License-Identifier: Apache-2.0

//go:build !linux

package supervisor

import "os/exec"

func bindToParent(*exec.Cmd) {}

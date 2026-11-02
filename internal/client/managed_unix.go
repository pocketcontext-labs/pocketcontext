//go:build !windows

package client

import (
	"os/exec"
	"syscall"
)

func detachTunnel(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }

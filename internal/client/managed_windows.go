//go:build windows

package client

import (
	"golang.org/x/sys/windows"
	"os/exec"
	"syscall"
)

func detachTunnel(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP, HideWindow: true}
}

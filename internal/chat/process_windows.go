package chat

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os/exec"
	"syscall"
	"unsafe"
)

func startProcess(cmd *exec.Cmd) (func(), error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_SUSPENDED}
	if err = cmd.Start(); err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	fail := func(e error) (func(), error) { cmd.Process.Kill(); cmd.Wait(); windows.CloseHandle(job); return nil, e }
	proc, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		return fail(err)
	}
	err = windows.AssignProcessToJobObject(job, proc)
	windows.CloseHandle(proc)
	if err != nil {
		return fail(err)
	}
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return fail(err)
	}
	defer windows.CloseHandle(snap)
	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	for err = windows.Thread32First(snap, &entry); err == nil; err = windows.Thread32Next(snap, &entry) {
		if entry.OwnerProcessID != uint32(cmd.Process.Pid) {
			continue
		}
		thread, e := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
		if e != nil {
			return fail(e)
		}
		_, e = windows.ResumeThread(thread)
		windows.CloseHandle(thread)
		if e != nil {
			return fail(e)
		}
		return func() { windows.TerminateJobObject(job, 1); windows.CloseHandle(job) }, nil
	}
	return fail(fmt.Errorf("agent initial thread unavailable"))
}

// File.Sync flushes the replacement contents; Windows does not support fsync
// on an ordinary directory handle. os.Rename uses MoveFileEx replacement.
func syncStateDirectory(string) error { return nil }

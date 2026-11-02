//go:build (!linux && !windows && !darwin) || (darwin && !cgo)

package bundle

func nativeReaderEnvironment() ReaderEnvironmentInfo {
	return ReaderEnvironmentInfo{"unknown", "unknown", "Desktop and browser availability could not be determined on this build"}
}

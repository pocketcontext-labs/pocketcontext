// Command pocketcontext is the PocketContext server and client in one binary.
package main

import (
	"os"

	"github.com/pocketcontext-labs/pocketcontext/internal/client"
)

func main() {
	os.Exit(client.Run(os.Args[1:]))
}

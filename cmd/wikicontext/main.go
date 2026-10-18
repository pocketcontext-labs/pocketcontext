// Command wikicontext is the WikiContext server and client in one binary.
package main

import (
	"os"

	"github.com/pocketcontext/wikicontext-bundle/internal/client"
)

func main() {
	os.Exit(client.Run(os.Args[1:]))
}

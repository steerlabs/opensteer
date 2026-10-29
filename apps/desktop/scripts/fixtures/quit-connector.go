package main

import (
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

// An offline connector peer: readiness and a descendant that the native
// containment owner must reap. It never reaches Cloudflare or holds credentials.
func main() {
	if len(os.Args) == 2 && os.Args[1] == "descendant" {
		for {
			time.Sleep(time.Hour)
		}
	}
	stopping := make(chan os.Signal, 1)
	signal.Notify(stopping, syscall.SIGTERM, syscall.SIGINT)
	grace := 30 * time.Second
	address := ""
	for i, arg := range os.Args {
		if arg == "--grace-period" && i+1 < len(os.Args) {
			var err error
			grace, err = time.ParseDuration(os.Args[i+1])
			if err != nil {
				panic(err)
			}
		}
		if arg == "--metrics" && i+1 < len(os.Args) {
			address = os.Args[i+1]
		}
	}
	if address == "" {
		os.Exit(2)
	}
	child := exec.Command(os.Args[0], "descendant")
	if err := child.Start(); err != nil {
		panic(err)
	}
	go func() { <-stopping; time.Sleep(grace); os.Exit(0) }()
	http.HandleFunc("/ready", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
	if err := http.ListenAndServe(address, nil); err != nil {
		panic(err)
	}
}

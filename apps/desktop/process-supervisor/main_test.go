package main

import (
	"io"
	"runtime"
	"strings"
	"testing"
)

func TestParseLaunch(t *testing.T) {
	target := absoluteTestPath("target")
	parsed, err := parseLaunch([]string{"--", target, "one", "two"}, false)
	if err != nil {
		t.Fatalf("parseLaunch returned an error: %v", err)
	}
	if parsed.executable != target || strings.Join(parsed.arguments, ",") != "one,two" || parsed.windowsCommandLine != "" {
		t.Fatalf("unexpected launch: %#v", parsed)
	}
	for _, input := range [][]string{
		nil,
		{"target"},
		{"--"},
		{"--", " "},
		{"--", "relative/target"},
		{"one", "--", target},
	} {
		for _, onWindows := range []bool{false, true} {
			if _, err := parseLaunch(input, onWindows); err == nil {
				t.Fatalf("parseLaunch(windows=%v) accepted %#v", onWindows, input)
			}
		}
	}
}

func TestParseLaunchWindowsCommandLine(t *testing.T) {
	target := absoluteTestPath("cmd.exe")
	line := `cmd.exe /d /s /c ""C:\a b\run.cmd" "x&y""`
	parsed, err := parseLaunch([]string{"--windows-command-line", line, "--", target}, true)
	if err != nil {
		t.Fatalf("parseLaunch returned an error: %v", err)
	}
	if parsed.executable != target || len(parsed.arguments) != 0 || parsed.windowsCommandLine != line {
		t.Fatalf("unexpected launch: %#v", parsed)
	}
	for _, input := range [][]string{
		{"--windows-command-line"},
		{"--windows-command-line", "--", target},
		{"--windows-command-line", " ", "--", target},
		{"--windows-command-line", "cmd.exe\x00", "--", target},
		{"--windows-command-line", line, target},
		{"--windows-command-line", line, "--", target, "trailing"},
	} {
		if _, err := parseLaunch(input, true); err == nil {
			t.Fatalf("parseLaunch accepted %#v", input)
		}
	}
	if _, err := parseLaunch([]string{"--windows-command-line", line, "--", target}, false); err == nil {
		t.Fatal("parseLaunch accepted --windows-command-line off Windows")
	}
}

func TestRunRejectsWindowsCommandLineOffWindowsAsUsageError(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the option is supported on Windows")
	}
	var stderr strings.Builder
	code := run([]string{"--windows-command-line", "cmd.exe", "--", absoluteTestPath("cmd.exe")}, nil, io.Discard, &stderr)
	if code != 64 || !strings.Contains(stderr.String(), "only supported on Windows") {
		t.Fatalf("run = %d, stderr %q; want usage error 64", code, stderr.String())
	}
}

func absoluteTestPath(name string) string {
	if runtime.GOOS == "windows" {
		return `C:\opensteer-test\` + name
	}
	return "/opensteer-test/" + name
}

func TestReadControlCommandsFailsClosed(t *testing.T) {
	tests := []struct {
		input string
		want  []controlCommand
	}{
		{input: "graceful\nforce\n", want: []controlCommand{commandGraceful, commandForce, commandControlClosed}},
		{input: "unknown\n", want: []controlCommand{commandInvalid}},
		{input: strings.Repeat("x", 2048), want: []controlCommand{commandInvalid}},
	}
	for _, test := range tests {
		var actual []controlCommand
		for command := range readControlCommands(strings.NewReader(test.input)) {
			actual = append(actual, command)
		}
		if len(actual) != len(test.want) {
			t.Fatalf("%q produced %#v, want %#v", test.input, actual, test.want)
		}
		for index := range actual {
			if actual[index] != test.want[index] {
				t.Fatalf("%q produced %#v, want %#v", test.input, actual, test.want)
			}
		}
	}
}

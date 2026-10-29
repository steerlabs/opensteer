package main

import (
	"strings"
	"testing"
)

func TestParseTarget(t *testing.T) {
	target, arguments, err := parseTarget([]string{"--", "/absolute/target", "one", "two"})
	if err != nil {
		t.Fatalf("parseTarget returned an error: %v", err)
	}
	if target != "/absolute/target" || strings.Join(arguments, ",") != "one,two" {
		t.Fatalf("unexpected target: %q %#v", target, arguments)
	}
	for _, input := range [][]string{
		nil,
		{"target"},
		{"--"},
		{"--", " "},
		{"--", "relative/target"},
	} {
		if _, _, err := parseTarget(input); err == nil {
			t.Fatalf("parseTarget accepted %#v", input)
		}
	}
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

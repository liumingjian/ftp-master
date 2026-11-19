package clock_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Functions that read or wait on the wall clock, by import path. Code outside
// package clock must go through a clock.Clock instead, and tests must advance a
// clock.Fake instead of sleeping. context deadlines count: they are measured
// against the wall clock.
var wallClockFuncs = map[string]map[string]bool{
	"time": {
		"Now": true, "Since": true, "Until": true, "Sleep": true,
		"After": true, "AfterFunc": true, "Tick": true, "NewTimer": true, "NewTicker": true,
	},
	"context": {
		"WithTimeout": true, "WithTimeoutCause": true,
		"WithDeadline": true, "WithDeadlineCause": true,
	},
}

// wallClockDirective exempts one use, on the same line or the line above, for
// waits that are about the outside world rather than domain time (for example
// a shutdown grace period). A reason must follow the directive.
const wallClockDirective = "//clock:wallclock "

func TestTimeIsOnlyReadThroughTheClock(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	clockFile := filepath.Join(root, "internal", "clock", "clock.go")

	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || path == clockFile {
			return nil
		}
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
		if err != nil {
			return err
		}
		if ast.IsGenerated(file) {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		for _, finding := range wallClockUses(fset, file) {
			t.Errorf("%s:%s; read time through clock.Clock instead", rel, finding)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// wallClockUses lists "line: problem" for every unexempted wall-clock use in file.
func wallClockUses(fset *token.FileSet, file *ast.File) []string {
	var findings []string
	banned := map[string]map[string]bool{} // local package name -> banned funcs
	for _, imp := range file.Imports {
		path, _ := strconv.Unquote(imp.Path.Value)
		funcs, ok := wallClockFuncs[path]
		if !ok {
			continue
		}
		name := filepath.Base(path)
		if imp.Name != nil {
			name = imp.Name.Name
		}
		if name == "." {
			// Calls would be bare identifiers that cannot be told apart from
			// local functions, so the import itself is not allowed.
			findings = append(findings, strconv.Itoa(fset.Position(imp.Pos()).Line)+
				" dot-imports "+strconv.Quote(path))
			continue
		}
		banned[name] = funcs
	}
	if len(banned) == 0 {
		return findings
	}

	exempt := map[int]bool{}
	for _, group := range file.Comments {
		for _, c := range group.List {
			if strings.HasPrefix(c.Text, wallClockDirective) &&
				strings.TrimSpace(strings.TrimPrefix(c.Text, wallClockDirective)) != "" {
				line := fset.Position(c.Pos()).Line
				exempt[line], exempt[line+1] = true, true
			}
		}
	}

	ast.Inspect(file, func(n ast.Node) bool {
		sel, ok := n.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		pkg, ok := sel.X.(*ast.Ident)
		if !ok || !banned[pkg.Name][sel.Sel.Name] {
			return true
		}
		line := fset.Position(sel.Pos()).Line
		if !exempt[line] {
			findings = append(findings, strconv.Itoa(line)+" uses "+pkg.Name+"."+sel.Sel.Name)
		}
		return true
	})
	return findings
}

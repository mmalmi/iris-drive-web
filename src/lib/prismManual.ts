// Prism highlights every code block on the page as soon as it loads unless told
// not to. The code viewer renders its own lines and asks for highlighting itself.
const scope = globalThis as { Prism?: { manual?: boolean } };
if (scope.Prism) scope.Prism.manual = true;
else scope.Prism = { manual: true };

export {};

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';

export type TerminalRawMutationOperation =
  | 'terminal.write'
  | 'terminal.reset'
  | 'terminal.resize'
  | 'terminal.clear'
  | 'fitAddon.fit'
  | 'terminal.options.windowsPty';

export interface TerminalSoleWriterFinding {
  file: string;
  line: number;
  operation: TerminalRawMutationOperation;
  expression: string;
}

export interface TerminalRawAdapterImportFinding {
  file: string;
  line: number;
  moduleSpecifier: string;
}

export interface TerminalSoleWriterInventory {
  analysisMode: 'typescript-ast-type-checker';
  rawMutationFindings: TerminalSoleWriterFinding[];
  rawAdapterImportFindings: TerminalRawAdapterImportFinding[];
  adapterOperations: Array<{
    operation: TerminalRawMutationOperation;
    present: boolean;
  }>;
}

export interface AnalyzeTerminalSoleWriterSourcesInput {
  frontendRoot: string;
  sources: Record<string, string>;
}

const RAW_MUTATION_OPERATIONS: readonly TerminalRawMutationOperation[] = [
  'terminal.write',
  'terminal.reset',
  'terminal.resize',
  'terminal.clear',
  'fitAddon.fit',
  'terminal.options.windowsPty',
];
const RAW_ADAPTER_RELATIVE_PATH = 'src/utils/terminalRawMutationAdapter.ts';
const COORDINATOR_RUNTIME_RELATIVE_PATH = 'src/utils/terminalWriteCoordinatorRuntime.ts';

function normalizePath(path: string): string {
  return resolve(path).replaceAll('\\', '/').toLowerCase();
}

function repositoryRelative(frontendRoot: string, path: string): string {
  return relative(frontendRoot, path).replaceAll('\\', '/');
}

function isXtermDeclaration(node: ts.Node, packageName: '@xterm/xterm' | '@xterm/addon-fit'): boolean {
  const declarationPath = node.getSourceFile().fileName.replaceAll('\\', '/').toLowerCase();
  return declarationPath.includes(`/node_modules/${packageName}/`);
}

function declarationName(node: ts.Node): string | null {
  if (
    (ts.isMethodSignature(node)
      || ts.isMethodDeclaration(node)
      || ts.isPropertySignature(node)
      || ts.isPropertyDeclaration(node))
    && node.name
  ) {
    return ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)
      ? node.name.text
      : null;
  }
  return null;
}

function resolveCallOperation(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): TerminalRawMutationOperation | null {
  const signatures = checker.getTypeAtLocation(expression).getCallSignatures();
  for (const signature of signatures) {
    const declaration = signature.getDeclaration();
    if (!declaration) continue;
    const name = declarationName(declaration);
    if (name === 'fit' && isXtermDeclaration(declaration, '@xterm/addon-fit')) {
      return 'fitAddon.fit';
    }
    if (
      (name === 'write' || name === 'reset' || name === 'resize' || name === 'clear')
      && isXtermDeclaration(declaration, '@xterm/xterm')
    ) {
      return `terminal.${name}`;
    }
  }
  return null;
}

function resolveWindowsPtyAssignmentOperation(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): TerminalRawMutationOperation | null {
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) {
    return null;
  }
  const propertyName = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression)
      ? expression.argumentExpression.text
      : null;
  if (propertyName !== 'windowsPty') return null;

  const symbol = checker.getSymbolAtLocation(
    ts.isPropertyAccessExpression(expression)
      ? expression.name
      : expression.argumentExpression ?? expression,
  ) ?? checker.getTypeAtLocation(expression.expression).getProperty('windowsPty');
  if (symbol?.declarations?.some(declaration => isXtermDeclaration(declaration, '@xterm/xterm'))) {
    return 'terminal.options.windowsPty';
  }
  return null;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function getModuleSpecifier(node: ts.Node): ts.StringLiteralLike | null {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
    return ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier : null;
  }
  if (
    ts.isCallExpression(node)
    && node.arguments.length === 1
    && ts.isStringLiteralLike(node.arguments[0])
    && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
    )
  ) {
    return node.arguments[0];
  }
  return null;
}

function analyzeProgram(input: {
  frontendRoot: string;
  program: ts.Program;
  moduleResolutionHost: ts.ModuleResolutionHost;
}): TerminalSoleWriterInventory {
  const checker = input.program.getTypeChecker();
  const frontendRoot = resolve(input.frontendRoot);
  const sourceRoot = normalizePath(resolve(frontendRoot, 'src'));
  const adapterPath = normalizePath(resolve(frontendRoot, RAW_ADAPTER_RELATIVE_PATH));
  const coordinatorRuntimePath = normalizePath(resolve(frontendRoot, COORDINATOR_RUNTIME_RELATIVE_PATH));
  const rawMutationFindings: TerminalSoleWriterFinding[] = [];
  const rawAdapterImportFindings: TerminalRawAdapterImportFinding[] = [];
  const adapterOperationSet = new Set<TerminalRawMutationOperation>();

  for (const sourceFile of input.program.getSourceFiles()) {
    const sourcePath = normalizePath(sourceFile.fileName);
    if (!sourcePath.startsWith(`${sourceRoot}/`) || sourceFile.isDeclarationFile) continue;
    const isAdapter = sourcePath === adapterPath;

    const visit = (node: ts.Node): void => {
      let operation: TerminalRawMutationOperation | null = null;
      if (ts.isCallExpression(node)) {
        operation = resolveCallOperation(checker, node.expression);
      } else if (
        ts.isBinaryExpression(node)
        && isAssignmentOperator(node.operatorToken.kind)
      ) {
        operation = resolveWindowsPtyAssignmentOperation(checker, node.left);
      }

      if (operation) {
        if (isAdapter) {
          adapterOperationSet.add(operation);
        } else {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          rawMutationFindings.push({
            file: repositoryRelative(frontendRoot, sourceFile.fileName),
            line: position.line + 1,
            operation,
            expression: node.getText(sourceFile),
          });
        }
      }

      const moduleSpecifier = getModuleSpecifier(node);
      if (moduleSpecifier && sourcePath !== coordinatorRuntimePath) {
        const resolution = ts.resolveModuleName(
          moduleSpecifier.text,
          sourceFile.fileName,
          input.program.getCompilerOptions(),
          input.moduleResolutionHost,
        ).resolvedModule;
        if (resolution && normalizePath(resolution.resolvedFileName) === adapterPath) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          rawAdapterImportFindings.push({
            file: repositoryRelative(frontendRoot, sourceFile.fileName),
            line: position.line + 1,
            moduleSpecifier: moduleSpecifier.text,
          });
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const byLocation = <T extends { file: string; line: number }>(left: T, right: T) => (
    left.file.localeCompare(right.file) || left.line - right.line
  );
  rawMutationFindings.sort(byLocation);
  rawAdapterImportFindings.sort(byLocation);
  return {
    analysisMode: 'typescript-ast-type-checker',
    rawMutationFindings,
    rawAdapterImportFindings,
    adapterOperations: RAW_MUTATION_OPERATIONS.map(operation => ({
      operation,
      present: adapterOperationSet.has(operation),
    })),
  };
}

export function analyzeTerminalSoleWriterSources(
  input: AnalyzeTerminalSoleWriterSourcesInput,
): TerminalSoleWriterInventory {
  const frontendRoot = resolve(input.frontendRoot);
  const sourceEntries = Object.entries(input.sources).map(([path, source]) => [
    resolve(frontendRoot, path),
    source,
  ] as const);
  const sourceByPath = new Map(sourceEntries.map(([path, source]) => [normalizePath(path), source]));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    skipLibCheck: true,
  };
  const defaultHost = ts.createCompilerHost(options, true);
  const moduleResolutionHost: ts.ModuleResolutionHost = {
    fileExists: path => sourceByPath.has(normalizePath(path)) || defaultHost.fileExists(path),
    readFile: path => sourceByPath.get(normalizePath(path)) ?? defaultHost.readFile(path),
    directoryExists: defaultHost.directoryExists?.bind(defaultHost),
    getCurrentDirectory: () => frontendRoot,
    getDirectories: defaultHost.getDirectories?.bind(defaultHost),
    realpath: defaultHost.realpath?.bind(defaultHost),
  };
  const host: ts.CompilerHost = {
    ...defaultHost,
    ...moduleResolutionHost,
    getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) {
      const source = sourceByPath.get(normalizePath(fileName));
      if (source !== undefined) {
        return ts.createSourceFile(fileName, source, languageVersion, true, ts.ScriptKind.TSX);
      }
      return defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    },
  };
  const program = ts.createProgram({
    rootNames: sourceEntries.map(([path]) => path),
    options,
    host,
  });
  return analyzeProgram({ frontendRoot, program, moduleResolutionHost });
}

export function collectTerminalSoleWriterInventory(frontendRootInput: string): TerminalSoleWriterInventory {
  const frontendRoot = resolve(frontendRootInput);
  const configPath = resolve(frontendRoot, 'tsconfig.app.json');
  const config = ts.readConfigFile(configPath, path => readFileSync(path, 'utf8'));
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, frontendRoot, undefined, configPath);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  }
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  return analyzeProgram({ frontendRoot, program, moduleResolutionHost: ts.sys });
}

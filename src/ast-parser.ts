import Parser, { SyntaxNode, Tree, Query, QueryMatch } from 'tree-sitter';
import TypeScriptLang from 'tree-sitter-typescript';
import * as fs from 'fs';

export class ASTParser {
  private parser: Parser;

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(TypeScriptLang.typescript);
  }

  public parseCode(sourceCode: string): Tree {
    if (!sourceCode || typeof sourceCode !== 'string') {
      throw new Error('Invalid source code provided.');
    }
    return this.parser.parse(sourceCode);
  }

  public parseFile(filePath: string): Tree {
    const sourceCode = fs.readFileSync(filePath, 'utf-8');
    return this.parseCode(sourceCode);
  }

  public printAST(node: SyntaxNode, indent: string = ''): void {
    console.log(`${indent}${node.type}`);
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        this.printAST(child, indent + '  ');
      }
    }
  }

  public findSymbolReferences(rootNode: SyntaxNode, symbol: string): SyntaxNode[] {
    const references: SyntaxNode[] = [];
    const queryText = `[
      (identifier) @id
      (type_identifier) @id
      (property_identifier) @id
      (method_definition) @id
      (property_signature) @id
      (member_expression) @id
    ]`;
    const query = new Query(this.parser.getLanguage(), queryText);
    const matches: QueryMatch[] = query.matches(rootNode);

    for (const match of matches) {
      for (const capture of match.captures) {
        if (capture.node.text === symbol) {
          references.push(capture.node);
        }
      }
    }

    return references;
  }
}
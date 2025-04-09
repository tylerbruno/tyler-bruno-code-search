#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { ASTParser } from "./ast-parser.js";
import * as fs from "fs";
const execAsync = promisify(exec);
/**
 * Escapes special characters in a string for use within shell commands.
 * @param input - The string to escape.
 * @returns The escaped string.
 */
function escapeShellArg(input) {
    return `'${input.replace(/'/g, "'\\''")}'`;
}
/**
 * Searches a directory for files containing a given word using ripgrep.
 * @param directory - The directory path to search.
 * @param word - The word to search for.
 * @param maxResults - The maximum number of results to return.
 * @returns An array of FileSearchResult objects with match details.
 */
async function searchWithRipgrep(directory, word, maxResults = 10) {
    try {
        const escapedWord = escapeShellArg(word);
        const escapedDir = escapeShellArg(directory);
        const cmd = `rg -n ${escapedWord} ${escapedDir}`;
        console.error(`Executing command: ${cmd}`);
        const { stdout } = await execAsync(cmd);
        if (!stdout.trim()) {
            return [];
        }
        const results = {};
        let totalMatches = 0;
        let limitReached = false;
        for (const line of stdout.split("\n").filter(Boolean)) {
            if (totalMatches >= maxResults) {
                limitReached = true;
                break;
            }
            const firstColonIndex = line.indexOf(':');
            if (firstColonIndex === -1)
                continue;
            const file = line.substring(0, firstColonIndex);
            const rest = line.substring(firstColonIndex + 1);
            const secondColonIndex = rest.indexOf(':');
            if (secondColonIndex === -1)
                continue;
            const lineNumber = parseInt(rest.substring(0, secondColonIndex), 10);
            const text = rest.substring(secondColonIndex + 1);
            if (!results[file]) {
                results[file] = [];
            }
            results[file].push({
                line: lineNumber,
                text: text
            });
            totalMatches++;
        }
        if (limitReached) {
            console.error(`Warning: Search limited to ${maxResults} results. Use more specific search terms for complete results.`);
        }
        const fileResults = Object.entries(results).map(([file, matches]) => ({
            file,
            matches,
        }));
        return fileResults;
    }
    catch (error) {
        console.error("Error executing ripgrep:", error);
        let errorMessage = "Failed to execute ripgrep.";
        if (error instanceof Error) {
            errorMessage += ` Error: ${error.message}`;
        }
        throw new Error(errorMessage);
    }
}
/**
 * Searches for references to a symbol using the AST parser.
 * This provides more accurate results than regex-based search by analyzing the code structure.
 *
 * @param directory - The directory path to search.
 * @param symbol - The symbol to search for.
 * @param maxResults - The maximum number of results to return.
 * @returns An array of FileReferenceResult objects with reference match details.
 */
async function searchReferencesWithAST(directory, symbol, maxResults = 10) {
    try {
        const astParser = new ASTParser();
        const results = {};
        let totalMatches = 0;
        let limitReached = false;
        // Find TypeScript files in the directory, excluding node_modules
        const { stdout } = await execAsync(`find ${escapeShellArg(directory)} -type f -name "*.ts" | grep -v "node_modules"`);
        const files = stdout.trim().split('\n').filter(Boolean);
        for (const file of files) {
            if (totalMatches >= maxResults) {
                limitReached = true;
                break;
            }
            try {
                const tree = astParser.parseFile(file);
                const references = astParser.findSymbolReferences(tree.rootNode, symbol);
                if (references.length > 0) {
                    if (!results[file]) {
                        results[file] = [];
                    }
                    for (const ref of references) {
                        if (totalMatches >= maxResults) {
                            limitReached = true;
                            break;
                        }
                        const fileContent = fs.readFileSync(file, 'utf-8');
                        const lines = fileContent.split('\n');
                        const lineContent = lines[ref.startPosition.row];
                        results[file].push({
                            line: ref.startPosition.row + 1, // Convert to 1-based line numbers
                            column: ref.startPosition.column + 1, // Convert to 1-based column numbers
                            text: lineContent.trim()
                        });
                        totalMatches++;
                    }
                }
            }
            catch (parseError) {
                console.error(`Error parsing file ${file}:`, parseError);
            }
        }
        if (limitReached) {
            console.error(`Warning: AST search limited to ${maxResults} results. Use more specific search terms for complete results.`);
        }
        const fileResults = Object.entries(results).map(([file, references]) => ({
            file,
            references,
        }));
        return fileResults;
    }
    catch (error) {
        console.error("Error executing AST parser for references:", error);
        let errorMessage = "Failed to execute AST parser for get_references.";
        if (error instanceof Error) {
            errorMessage += ` Error: ${error.message}`;
        }
        throw new Error(errorMessage);
    }
}
const server = new McpServer({
    name: "codebase-search",
    version: "1.0.0",
});
/**
 * Tool: search-word
 * Description: Searches the codebase for lines containing a specified word using ripgrep.
 */
server.tool("search-word", "Search for a word in the codebase using ripgrep", {
    word: z.string().describe("The word to search for in the codebase"),
    codebasePath: z
        .string()
        .describe("ALWAYS PROVIDE THIS PATH: Path to the codebase directory provided to you by the environment information"),
}, async ({ word, codebasePath }) => {
    try {
        const results = await searchWithRipgrep(codebasePath, word);
        if (results.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: `No matches found for "${word}" in ${codebasePath}.`,
                    },
                ],
            };
        }
        let responseText = `Matches for "${word}" in ${codebasePath}:\n\n`;
        for (const result of results) {
            responseText += `File: ${result.file}\n`;
            result.matches.forEach((match) => {
                responseText += `  Line ${match.line}: ${match.text}\n`;
            });
            responseText += "\n";
        }
        return {
            content: [
                {
                    type: "text",
                    text: responseText,
                },
            ],
        };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            content: [
                {
                    type: "text",
                    text: `Codebase path: ${codebasePath} Error: ${errorMessage}`,
                },
            ],
        };
    }
});
/**
 * Tool: get_references
 * Description: Retrieves references to a specified symbol in the codebase using AST parsing.
 */
server.tool("get_references", "Get references to a symbol in the codebase using AST parsing for accurate results", {
    symbol: z
        .string()
        .describe("The symbol for which to get references"),
    codebasePath: z
        .string()
        .describe("ALWAYS PROVIDE THIS PATH: Path to the codebase directory provided to you by the environment information")
}, async ({ symbol, codebasePath }) => {
    try {
        const results = await searchReferencesWithAST(codebasePath, symbol);
        if (results.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: `No references found for "${symbol}" in ${codebasePath}.`,
                    },
                ],
            };
        }
        let responseText = `References for "${symbol}" in ${codebasePath}:\n\n`;
        for (const result of results) {
            responseText += `File: ${result.file}\n`;
            result.references.forEach((ref) => {
                responseText += `  Line ${ref.line}, Column ${ref.column}: ${ref.text}\n`;
            });
            responseText += "\n";
        }
        return {
            content: [
                {
                    type: "text",
                    text: responseText,
                },
            ],
        };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            content: [
                {
                    type: "text",
                    text: `Error: ${errorMessage}`,
                },
            ],
        };
    }
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Codebase Search MCP Server running on stdio.");
}
main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});

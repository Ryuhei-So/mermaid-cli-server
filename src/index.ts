#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { execa } from 'execa';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import os from 'os'; // Import os module for tmpdir

// Retrieve Puppeteer path from environment variable or use the provided default
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH;
if (!PUPPETEER_EXECUTABLE_PATH) {
  throw new Error('PUPPETEER_EXECUTABLE_PATH environment variable is required but not set.');
}

// Validate input arguments for generate_image tool
interface GenerateImageArgs {
  code: string;
  name: string;
  folder?: string;
}

const isValidGenerateImageArgs = (args: any): args is GenerateImageArgs =>
  typeof args === 'object' &&
  args !== null &&
  typeof args.code === 'string' &&
  typeof args.name === 'string' &&
  (args.folder === undefined || typeof args.folder === 'string');

class MermaidCliServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'mermaid-cli-server', // Updated server name if needed
        version: '0.1.0',
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'generate_image',
          description: 'Generate PNG image from mermaid markdown using Mermaid CLI',
          inputSchema: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'The mermaid markdown code to generate an image from',
              },
              name: {
                type: 'string',
                description: 'Base name for the output PNG file (without extension)',
              },
              folder: {
                type: 'string',
                description: 'Absolute path to the directory where the image should be saved (optional, defaults to current working directory)',
              },
            },
            required: ['code', 'name'],
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'generate_image') {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
      }

      if (!isValidGenerateImageArgs(request.params.arguments)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Invalid arguments for generate_image tool. Required: code (string), name (string). Optional: folder (string).'
        );
      }

      const { code, name, folder } = request.params.arguments;
      const tempInputFile = path.join(os.tmpdir(), `${uuidv4()}.mmd`); // Use OS temp directory
      const outputFileName = `${name}.png`;
      // Use provided folder or default to the server's script directory if not specified
      const serverScriptDir = path.dirname(new URL(import.meta.url).pathname);
      const outputDir = folder ? path.resolve(folder) : serverScriptDir; // Default to server script directory
      const outputFile = path.join(outputDir, outputFileName);

      try {
        // Ensure output directory exists
        if (folder) {
            await fs.mkdir(outputDir, { recursive: true });
        }

        // Write Mermaid code to temporary file
        await fs.writeFile(tempInputFile, code);

        // Execute Mermaid CLI command
        const command = 'npx';
        const args = [
            '@mermaid-js/mermaid-cli',
            '-i',
            tempInputFile,
            '-o',
            outputFile,
            // Add other mmdc options if needed, e.g., -b transparent
        ];

        console.error(`Executing: ${command} ${args.join(' ')} with PUPPETEER_EXECUTABLE_PATH=${PUPPETEER_EXECUTABLE_PATH}`); // Log command execution

        const { stdout, stderr } = await execa(command, args, {
          env: {
            ...process.env, // Inherit existing environment variables
            PUPPETEER_EXECUTABLE_PATH: PUPPETEER_EXECUTABLE_PATH,
          },
          // Consider adding a timeout if needed
        });

        console.error('Mermaid CLI stdout:', stdout); // Log stdout
        if (stderr) {
            console.error('Mermaid CLI stderr:', stderr); // Log stderr
        }

        // Check if output file was created
        try {
            await fs.access(outputFile);
        } catch (accessError) {
            console.error(`Output file not found at ${outputFile} after command execution.`);
            throw new McpError(ErrorCode.InternalError, `Mermaid CLI failed to generate image. Output file not found. Stderr: ${stderr}`);
        }


        // Return the path to the generated image
        return {
          content: [
            {
              type: 'text',
              text: `Image successfully generated at: ${outputFile}`,
            },
            // Optionally include the path as structured data if needed later
            // { type: 'json', data: { imagePath: outputFile } }
          ],
        };
      } catch (error: any) {
        console.error('Error during image generation:', error); // Log the full error
        // Provide more specific error feedback
        let errorMessage = `Failed to generate image: ${error.message}`;
        if (error.stderr) {
            errorMessage += `\nStderr: ${error.stderr}`;
        }
        if (error.stdout) {
            errorMessage += `\nStdout: ${error.stdout}`;
        }
        throw new McpError(ErrorCode.InternalError, errorMessage);
      } finally {
        // Clean up temporary file
        try {
          await fs.unlink(tempInputFile);
        } catch (cleanupError) {
          console.error(`Failed to delete temporary file ${tempInputFile}:`, cleanupError);
          // Don't throw here, as the main operation might have succeeded or failed already
        }
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Mermaid CLI MCP server running on stdio');
  }
}

const server = new MermaidCliServer();
server.run().catch(console.error);

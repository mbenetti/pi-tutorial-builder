import fs from 'node:fs';
import path from 'node:path';

// Mock ExtensionAPI
const registeredCommands = {};

class MockExtensionAPI {
	registerCommand(name, spec) {
		console.log(`Registered command: ${name}`);
		registeredCommands[name] = spec;
	}
	registerTool() {}
	on() {}
	appendEntry() {}
}

const piMock = new MockExtensionAPI();

// For ESM dynamic imports or direct imports, we import tutorial-builder.js
const { default: initExtension } = await import('./tutorial-builder.js');
initExtension(piMock);

// Setup mock context with a real, complete Model object from the pi-ai catalog (Gemini 2.5 Flash)
const ctxMock = {
	mode: "agent", // Run in non-TUI mode to bypass BorderedLoader and runPipeline directly
	cwd: "/Users/maurobenetti/Documents/Datascience/Pocket_pi",
	model: {
		id: "google/gemini-2.5-flash",
		name: "Google: Gemini 2.5 Flash",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 0.3,
			output: 2.5,
			cacheRead: 0.03,
			cacheWrite: 0.083333
		},
		contextWindow: 1048576,
		maxTokens: 65535,
		compat: {
			supportsDeveloperRole: false,
			thinkingFormat: "openrouter"
		}
	},
	modelRegistry: {
		async getApiKeyAndHeaders(model) {
			const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
			if (!apiKey) {
				throw new Error("No OPENAI_API_KEY or OPENROUTER_API_KEY found in environment!");
			}
			return {
				ok: true,
				apiKey: apiKey,
				headers: {}
			};
		}
	},
	ui: {
		notify(msg, type) {
			console.log("[NOTIFY CALLED]", { msg, type });
		}
	}
};

// Arguments specified by user
const commandArgs = "/Users/maurobenetti/Documents/Datascience/Pocket_pi --max-abstractions 20 --language english --output /Users/maurobenetti/Documents/Datascience/Pocket_pi/tutorial_agent_features --focus \"The core features, designs, and architectures of the pocket-pi agent (hierarchical configurations, workspace trust boundary confirmation, log tree SessionManager, unified file/bash/search tool system, workflow state-machine nodes, and uv-based bootstrapping)\"";

async function execute() {
	const cmd = registeredCommands["tutorial"];
	if (!cmd) {
		console.error("Command 'tutorial' not registered!");
		process.exit(1);
	}

	console.log("Executing tutorial-builder with args:", commandArgs);
	try {
		await cmd.handler(commandArgs, ctxMock);
		console.log("Tutorial compilation finished successfully!");
	} catch (err) {
		console.error("Error executing handler:", err);
		process.exit(1);
	}
}

execute();

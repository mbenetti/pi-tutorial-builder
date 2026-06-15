import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

// Default patterns matching Python implementation
const DEFAULT_INCLUDE_PATTERNS = [
	"*.py", "*.js", "*.jsx", "*.ts", "*.tsx", "*.go", "*.java", "*.pyi", "*.pyx",
	"*.c", "*.cc", "*.cpp", "*.h", "*.md", "*.rst", "*Dockerfile",
	"*Makefile", "*.yaml", "*.yml"
];

const DEFAULT_EXCLUDE_PATTERNS = [
	"**/assets/**", "**/data/**", "**/images/**", "**/public/**", "**/static/**", "**/temp/**",
	"**/docs/**", "**/doc/**", "**/venv/**", "**/.venv/**", "**/*test*", "**/tests/**",
	"**/examples/**", "**/v1/**", "**/dist/**", "**/build/**", "**/experimental/**",
	"**/deprecated/**", "**/misc/**", "**/legacy/**", "**/.git/**", "**/.github/**",
	"**/.next/**", "**/.vscode/**", "**/obj/**", "**/bin/**", "**/node_modules/**", "*.log"
];

const MAX_FILE_SIZE = 100 * 1024; // 100KB

interface SourceFile {
	path: string;
	content: string;
}

interface Abstraction {
	name: string;
	description: string;
	files: number[]; // indices of original file arrays
}

interface RelationshipDetail {
	from: number;
	to: number;
	label: string;
}

interface RelationshipsData {
	summary: string;
	details: RelationshipDetail[];
}

interface ChapterFilename {
	num: number;
	name: string;
	filename: string;
}

// Simple wildcard match helper simulating fnmatch / pathspec
function matchesPattern(fileRelativePath: string, patterns: string[]): boolean {
	const normalizedPath = fileRelativePath.replace(/\\/g, "/");
	for (const pattern of patterns) {
		const normalizedPattern = pattern.replace(/\\/g, "/");
		// Translate wildcard pattern to regex
		const regexStr = "^" + normalizedPattern
			.replace(/\.\./g, "__DOTDOT__") // Keep special sequences
			.replace(/\./g, "\\.")
			.replace(/\*\*/g, ".*")
			.replace(/\*/g, "[^/]*")
			.replace(/\?/g, "[^/]")
			.replace(/__DOTDOT__/g, "..") + "$";
		const regex = new RegExp(regexStr, "i");
		if (regex.test(normalizedPath) || regex.test(path.basename(normalizedPath))) {
			return true;
		}
	}
	return false;
}

// Robust JSON block extractor
function extractJsonBlock<T>(content: string): T {
	try {
		// Look for ```json ... ``` blocks
		const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/i);
		const rawJson = jsonMatch ? jsonMatch[1].trim() : content.trim();

		// Cleanup trailing commas in arrays/objects if LLM slips
		const cleanedJson = rawJson
			.replace(/,\s*([\]}])/g, "$1") // Remove trailing commas
			.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, "$1"); // Strip any potential trailing comments

		return JSON.parse(cleanedJson) as T;
	} catch (e: any) {
		throw new Error(`Failed to parse extracted JSON contents. Error: ${e.message}. Content received was: \n${content}`);
	}
}

// Concurrent queue helper to build folders with specified concurrent limits
async function concurrentMap<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const results: R[] = [];
	const executing: Promise<void>[] = [];
	
	for (let i = 0; i < items.length; i++) {
		const p = Promise.resolve().then(() => fn(items[i], i));
		results.push(p as any);
		if (limit <= items.length) {
			const e: Promise<void> = (p as any).then(() => {
				executing.splice(executing.indexOf(e), 1);
			});
			executing.push(e);
			if (executing.length >= limit) {
				await Promise.race(executing);
			}
		}
	}
	return Promise.all(results);
}

// Crawler for local folder
function crawlLocalDirectory(dirPath: string): SourceFile[] {
	const filesList: SourceFile[] = [];

	function walk(currentDir: string) {
		const items = fs.readdirSync(currentDir, { withFileTypes: true });
		for (const item of items) {
			const absolutePath = path.join(currentDir, item.name);
			const relativePath = path.relative(dirPath, absolutePath);

			// Exclude checks
			if (matchesPattern(relativePath, DEFAULT_EXCLUDE_PATTERNS)) {
				continue;
			}

			if (item.isDirectory()) {
				walk(absolutePath);
			} else if (item.isFile()) {
				// Include checks
				if (matchesPattern(relativePath, DEFAULT_INCLUDE_PATTERNS)) {
					const size = fs.statSync(absolutePath).size;
					if (size <= MAX_FILE_SIZE) {
						try {
							const content = fs.readFileSync(absolutePath, "utf-8");
							// basic check for binary (null bytes)
							if (!content.includes("\0")) {
								filesList.push({ path: relativePath, content });
							}
						} catch {
							// skip unreadable files
						}
					}
				}
			}
		}
	}

	walk(dirPath);
	return filesList;
}

// Shell command LLM execution with robust retries
async function callLlmWithRetry(
	ctx: ExtensionCommandContext,
	systemPrompt: string,
	prompt: string,
	validator: (content: string) => boolean,
	retries = 3,
	signal?: AbortSignal
): Promise<string> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error);
	}

	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: prompt }],
				timestamp: Date.now(),
			};

			// Update the loader message to show attempts or sub-tasks dynamically
			if (typeof (global as any)._piLoader_set === "function") {
				(global as any)._piLoader_set(systemPrompt.substring(0, 30) + ` (Attempt ${attempt}/5)...`);
			}

			const response = await complete(
				ctx.model!,
				{ systemPrompt, messages: [userMessage] },
				{ apiKey: auth.apiKey, headers: auth.headers, signal }
			);

			if (response.stopReason === "aborted") {
				throw new Error("Generation aborted by user.");
			}

			const textContent = response.content?.find((c) => c.type === "text");
			if (textContent && textContent.type === "text") {
				// Let's print out the exact LLM content or why it failed
				if (validator(textContent.text)) {
					return textContent.text;
				} else {
					throw new Error(`LLM output did not satisfy validation criteria. Received content length: ${textContent.text.length}. Content peak: ${textContent.text.substring(0, 100).replace(/\n/g, " ")}`);
				}
			}
			throw new Error("Invalid output formatting or missing payload elements.");
		} catch (error: any) {
			if (attempt === retries) throw error;
			ctx.ui.notify(`LLM Call attempt ${attempt}/${retries} failed: ${error.message}. Retrying...`, "warning");
			// simple backoff wait
			await new Promise((r) => setTimeout(r, 1000 * attempt));
		}
	}
	throw new Error("Max retries exceeded during validation");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("tutorial", {
		description: "Generate a comprehensive tutorial from a codebase or remote repo",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Tutorial builder command requires interactive TUI mode.", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model active. Please select a model first.", "error");
				return;
			}

			// Parse command arguments: /tutorial <url_or_path> [--max-abstractions 10] [--language eng] [--output ./tutorial/<name>]
			const parsedArgs = args?.trim().split(/\s+/) || [];
			if (parsedArgs.length === 0 || parsedArgs[0] === "") {
				ctx.ui.notify("Usage: /tutorial <repo_url_or_local_path> [--max-abstractions 10] [--language english] [--output <path>]", "error");
				return;
			}

			const sourceInput = parsedArgs[0];
			let maxAbstractions = 10;
			let language = "english";
			let customOutput: string | undefined;

			for (let i = 1; i < parsedArgs.length; i++) {
				if (parsedArgs[i] === "--max-abstractions" && parsedArgs[i+1]) {
					maxAbstractions = parseInt(parsedArgs[i+1], i+1);
					i++;
				} else if (parsedArgs[i] === "--language" && parsedArgs[i+1]) {
					language = parsedArgs[i+1];
					i++;
				} else if (parsedArgs[i] === "--output" && parsedArgs[i+1]) {
					customOutput = parsedArgs[i+1];
					i++;
				}
			}

			// Generate tutorial process inside BorderedLoader to cleanly block and present statuses
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Step 1: Setting up environment...", { height: 12 });
				
				// Expose loader text changer globally so callLlmWithRetry can update the spinner text
				(global as any)._piLoader_set = (text: string) => {
					loader.text = text;
				};

				loader.onAbort = () => {
					(global as any)._piLoader_set = undefined;
					ctx.ui.notify("Tutorial building cancelled.", "info");
					done();
				};

				// Start processing asynchronously so we can return the loader widget immediately to be rendered by key handlers/TUI loop
				const runPipeline = async () => {
					try {
						let tempDir: string | undefined;
						let sourcePath = sourceInput;
						let projectName = "project";

						// Check if sourceInput is a network Git Repo
						const isRemote = sourceInput.startsWith("http") || sourceInput.startsWith("git@") || sourceInput.includes("github.com");
						if (isRemote) {
							loader.text = "Cloning remote repository into temporary directory...";
							tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tutorial-"));
							projectName = sourceInput.substring(sourceInput.lastIndexOf("/") + 1).replace(".git", "");
							
							try {
								execSync(`git clone --depth 1 "${sourceInput}" "${tempDir}"`, { stdio: "ignore" });
								sourcePath = tempDir;
							} catch (e: any) {
								throw new Error(`Failed to clone remote git repository: ${e.message}`);
							}
						} else {
							// Local directory
							sourcePath = path.resolve(ctx.cwd, sourceInput);
							if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
								throw new Error(`Local directory path could not be found: ${sourcePath}`);
							}
							projectName = path.basename(sourcePath);
						}

						// Fetch Files
						loader.text = "Crawling local repository files...";
						const files = crawlLocalDirectory(sourcePath);
						if (files.length === 0) {
							throw new Error("No compatible code files parsed within this repository workspace.");
						}
						ctx.ui.notify(`Successfully parsed ${files.length} source code files. Entering pipeline.`, "info");

						// Prepare Context files list for references
						const fileListingForPrompt = files.map((f, i) => `- ${i} # ${f.path}`).join("\n");
						const fullFilesContext = files.map((f, i) => `--- File Index ${i}: ${f.path} ---\n${f.content}\n\n`).join("");

						// 1. IdentifyAbstractions
						loader.text = "Step 2: Identifying core abstractions (this can take up to 30 seconds)...";
						const identifySystem = "You are a code architecture learning specialist. Analyze code files and return abstractions list.";
						const identifyPrompt = `For the project \`${projectName}\`:

Codebase Context:
${fullFilesContext}

Analyze the context. Identify the top 5 to ${maxAbstractions} core abstraction concepts to explain to a newcomer.
IMPORTANT: Generate the \`name\` and \`description\` for each abstraction in **${language}** language. Do NOT use English unless the concept is a code proper noun.
For each abstraction, provide:
1. A concise \`name\`.
2. A beginner-friendly \`description\` explaining what it is with a simple analogy, in around 100 words.
3. A list of relevant original \`file_indices\` (as numbers).

List of files with their indices:
${fileListingForPrompt}

Output ONLY a JSON array of objects inside a single \`\`\`json\`\`\` code block as matching this example structure:
\`\`\`json
[
  {
    "name": "AbstrName",
    "description": "Explains concept clearly.",
    "file_indices": [0, 3]
  }
]
\`\`\``;

						const rawAbstractions = await callLlmWithRetry(
							ctx,
							identifySystem,
							identifyPrompt,
							(resp) => {
								try {
									const parsed = extractJsonBlock<any[]>(resp);
									return Array.isArray(parsed) && parsed.length > 0 && parsed.every(abs => abs && (abs.name || abs.description || abs.file_indices));
								} catch {
									return false;
								}
							},
							3,
							loader.signal
						);

						const abstractionsRaw = extractJsonBlock<any[]>(rawAbstractions);
						if (!Array.isArray(abstractionsRaw)) throw new Error("LLM identifying abstractions did not return a array.");

						// Validate indices and sanitize files map
						const abstractions: Abstraction[] = abstractionsRaw.map((abs) => {
							const validIndices = (abs.file_indices || []).filter((idx: any) => {
								const n = parseInt(idx, 10);
								return !isNaN(n) && n >= 0 && n < files.length;
							});
							return {
								name: abs.name || "Concept",
								description: abs.description || "Core abstraction concept.",
								files: validIndices
							};
						});

						// 2. AnalyzeRelationships
						loader.text = "Step 3: Determining connections/relationships between abstractions...";
						const relationshipListing = abstractions.map((a, i) => `- Index ${i}: ${a.name} (Files: ${a.files.join(", ")}). Description: ${a.description}`).join("\n");
						
						// Build partial files content context
						const uniqueIndices = Array.from(new Set(abstractions.flatMap(a => a.files)));
						const relationshipFilesContext = uniqueIndices.map(idx => `--- File: ${ctx.cwd} # ${files[idx].path} ---\n${files[idx].content}`).join("\n\n");

						const relationshipSystem = "You are a software architect mapping connections between abstractions.";
						const relationshipPrompt = `Analyze the concepts below for project \`${projectName}\`.

Abstractions Map:
${relationshipListing}

Code Snippets:
${relationshipFilesContext}

Please generate:
1. A brief summary of project main functionality in **${language}**, using markdown bold/italic formatting to stress concepts.
2. A list of connections/relationships where abstractions connect to each other.

Output ONLY a single valid JSON object inside \`\`\`json\`\`\` code tags with the format:
\`\`\`json
{
  "summary": "Main purpose breakdown...",
  "relationships": [
    {
      "from_abstraction": 0,
      "to_abstraction": 1,
      "label": "Brief label"
    }
  ]
}
\`\`\s

IMPORTANT: Both "summary" and relationship "label" fields must be fully generated in **${language}**.
Keep the relationship "label" strictly very short (1 to 3 words maximum, e.g., "Manages", "Inherits", "Spawns", "Triggers", "Uses"). This ensures diagram labels do not overlap!
Ensure to output only valid JSON.`;

						const rawRelationships = await callLlmWithRetry(
							ctx,
							relationshipSystem,
							relationshipPrompt,
							(resp) => {
								try {
									const parsed = extractJsonBlock<any>(resp);
									return !!(parsed && parsed.summary && parsed.relationships);
								} catch {
									return false;
								}
							},
							3,
							loader.signal
						);

						const relationshipsRaw = extractJsonBlock<any>(rawRelationships);
						const relationships: RelationshipsData = {
							summary: relationshipsRaw.summary || "",
							details: (relationshipsRaw.relationships || []).map((rel: any) => ({
								from: parseInt(rel.from_abstraction, 10) || 0,
								to: parseInt(rel.to_abstraction, 10) || 0,
								label: rel.label || "Uses"
							}))
						};

						// 3. OrderChapters
						loader.text = "Step 4: Mapping the ideal textbook reading order...";
						const chapterOrderSystem = "You are an educational designer mapping the best sequence of concepts.";
						const chapterListing = abstractions.map((a, i) => `- ${i} # ${a.name}`).join("\n");
						const chapterOrderPrompt = `We are mapping a tutorial walkthrough sequence for \`${projectName}\`.
Given these concepts:
${chapterListing}

Project Summary:
${relationships.summary}

What is the optimal instructional order to describe these abstractions from first (basic/foundational components/entry points) to last (lower level details)?
List all ${abstractions.length} indices exactly once.

Output ONLY a JSON array of numbers inside \`\`\`json\`\`\` tags reflecting the best index sequence:
\`\`\`json
[2, 0, 1, 3]
\`\`\``;

						const rawOrder = await callLlmWithRetry(
							ctx,
							chapterOrderSystem,
							chapterOrderPrompt,
							(resp) => {
								try {
									const parsed = extractJsonBlock<number[]>(resp);
									return Array.isArray(parsed) && parsed.length > 0 && parsed.every(n => typeof n === "number");
								} catch {
									return false;
								}
							},
							3,
							loader.signal
						);

						const orderRaw = extractJsonBlock<number[]>(rawOrder);
						const chapterOrder = Array.isArray(orderRaw) ? orderRaw : Array.from({ length: abstractions.length }, (_, i) => i);
						
						// Pre-create chapter metadata maps
						const chapterFilenames: { [key: number]: ChapterFilename } = {};
						const allChaptersList: string[] = [];
						
						chapterOrder.forEach((absIdx, i) => {
							const abs = abstractions[absIdx];
							const safeName = abs.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
							const filename = `${String(i + 1).padStart(2, "0")}_${safeName}.md`;
							chapterFilenames[absIdx] = {
								num: i + 1,
								name: abs.name,
								filename
							};
							allChaptersList.push(`${i + 1}. [${abs.name}](${filename})`);
						});
						const fullChapterListingStr = allChaptersList.join("\n");

						// 4. WriteChapters (Concurrent map with limit of 3)
						loader.text = "Step 5: Drafting guidebook chapters (drafting 3 chapters in parallel)...";
						
						const writtenChaptersTexts: string[] = [];
						
						await concurrentMap(chapterOrder, 3, async (absIdx, currentIdx) => {
							const abs = abstractions[absIdx];
							const chapterNum = currentIdx + 1;
							ctx.ui.setStatus("tutorial-builder", `Writing Chapter ${chapterNum}/${abstractions.length}: ${abs.name}...`);

							// Fetch only local related files context for this chapter
							const relatedContent = abs.files.map(idx => `--- File: ${files[idx].path} ---\n${files[idx].content}`).join("\n\n");
							const prevChapter = currentIdx > 0 ? chapterFilenames[chapterOrder[currentIdx - 1]] : null;
							const nextChapter = currentIdx < chapterOrder.length - 1 ? chapterFilenames[chapterOrder[currentIdx + 1]] : null;

							const previousSummariesText = writtenChaptersTexts.slice(0, currentIdx).join("\n---\n");

							const writeSystem = "You are a master technical educator writing a beginner-friendly code tutorial chapter.";
							const writePrompt = `Write Chapter ${chapterNum} of a developer tutorial for \`${projectName}\` about the concept: "${abs.name}".
Language requirement: Write the entire chapter exclusively in **${language}**.

Concept description:
${abs.description}

Complete Book Index:
${fullChapterListingStr}

Context from earlier chapters:
${previousSummariesText || "This is the first chapter."}

Related Code Files:
${relatedContent || "No specific raw files were mapped to this abstraction."}

Write this Chapter in beautiful, beginner-friendly Markdown utilizing these strict guidelines:
1. Start with a clean Markdown H1 header: \`# Chapter ${chapterNum}: ${abs.name}\`
2. Begin with a clear transition explaining how this relates to any previous abstraction (using direct relative file links where useful).
3. Walk down key details. Keep code snippets under 10 lines, explaining after every blocks with concrete analogies.
4. Explain step-by-step internal code execution routines. If helpful, draw a small sequence/architecture diagram inside text using \`\`\`mermaid \`\`\`.
5. Finish with a transition note linking smoothly to the next concept.

Provide ONLY the raw Markdown document contents in **${language}**. Do not include backticks surrounding the whole file.`;

							const chapterDoc = await callLlmWithRetry(
								ctx,
								writeSystem,
								writePrompt,
								(resp) => resp.length > 100, // length verification
								3,
								loader.signal
							);

							writtenChaptersTexts[currentIdx] = chapterDoc;
						});

						// 5. CombineTutorial
						loader.text = "Step 6: Assembling markdown index and output directory structure...";
						
						// Build relationships Mermaid diagram with shortened edge labels to prevent overlaps
						const mermaidLines = ["flowchart TD"];
						abstractions.forEach((abs, i) => {
							mermaidLines.push(`    A${i}["${abs.name}"]`);
						});
						relationships.details.forEach((rel) => {
							let shortLabel = rel.label || "Uses";
							// Keep labels strictly under 15 characters, truncating if necessary to keep diagram readable
							if (shortLabel.length > 15) {
								shortLabel = shortLabel.substring(0, 12).trim() + "...";
							}
							mermaidLines.push(`    A${rel.from} -- "${shortLabel}" --> A${rel.to}`);
						});
						const mermaidDiagram = mermaidLines.join("\n");

						// Index page contents
						let indexContent = `# Tutorial: ${projectName}\n\n`;
						indexContent += `${relationships.summary}\n\n`;
						indexContent += `**Source Repository:** ${sourceInput}\n\n`;
						indexContent += "```mermaid\n" + mermaidDiagram + "\n```\n\n";
						indexContent += "<h2>Chapters</h2>\n\n" + fullChapterListingStr + "\n\n---\nGenerated by Pi Tutorial Builder Extension.";

						// Resolve complete outputs path
						const outputFolderBase = customOutput ? path.resolve(ctx.cwd, customOutput) : path.join(ctx.cwd, "tutorial", projectName);
						fs.mkdirSync(outputFolderBase, { recursive: true });

						// Write 00_index.md instead of index.md
						fs.writeFileSync(path.join(outputFolderBase, "00_index.md"), indexContent);

						// Write chapters
						chapterOrder.forEach((absIdx, idx) => {
							const meta = chapterFilenames[absIdx];
							const chapterFileContent = writtenChaptersTexts[idx] + "\n\n---\nGenerated with Pi Tutorial Builder.";
							fs.writeFileSync(path.join(outputFolderBase, meta.filename), chapterFileContent);
						});

						// Clean temp if used
						if (tempDir && fs.existsSync(tempDir)) {
							fs.rmSync(tempDir, { recursive: true, force: true });
						}

						ctx.ui.setStatus("tutorial-builder", "");
						(global as any)._piLoader_set = undefined;
						ctx.ui.notify(`Tutorial compiled successfully! Saved to: ${outputFolderBase}`, "info");

					} catch (err: any) {
						(global as any)._piLoader_set = undefined;
						ctx.ui.notify(`Error generating tutorial: ${err.message}`, "error");
					} finally {
						done();
					}
				};

				runPipeline();

				return loader;
			});
		}
	});
}

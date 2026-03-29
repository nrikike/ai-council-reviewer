const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { 
  callGeminiWithRetry, 
  shouldReviewFile,
  parseLlmJson,
  validateFilePath,
  extractSearchTokensFromDiff,
  findFilesContainingTokens,
  loadPrompt
} = require("./utils");

// Parse args
const args = process.argv.slice(2);
const agentIndex = args.indexOf("--agent");
let agentType = "general";

if (agentIndex !== -1 && args[agentIndex + 1] && !args[agentIndex + 1].startsWith("-")) {
  agentType = args[agentIndex + 1];
}

const { z } = require("zod");

// Review Schema Definition
const ReviewItemSchema = z.object({
    file: z.string().optional(),
    filepath: z.string().optional(),
    line: z.number().nullable().optional(),
    severity: z.string().optional(),
    message: z.string().optional(),
    suggestion: z.string().optional(),
    rationale: z.string().optional(),
  })
  .transform(data => {
    // 1. Normalize File Path: accept 'file' OR 'filepath', output only 'file'
    // Warn if 'filepath' is used (should use 'file' in agent prompts)
    if (data.filepath && !data.file) {
      console.warn(`[Schema] Agent output uses 'filepath' instead of 'file'. Please update the agent prompt to use 'file'. Normalizing automatically.`);
    }
    // Destructure to exclude 'filepath' from rest (intentionally unused - we use data.filepath directly)
    const { filepath: _filepath, ...rest } = data;
    return {
      ...rest,
      file: data.file || data.filepath,
      // 2. Normalize Severity (handle uppercase)
      severity: data.severity ? data.severity.toLowerCase() : undefined
    };
  })
  .pipe(z.object({
    file: z.string().optional(), // Optional to support general comments
    line: z.number().nullable().optional(),
    severity: z.enum(["critical", "high", "medium", "low", "info", "error", "warning", "suggestion"]).optional(),
    message: z.string().optional(),
    suggestion: z.string().optional(),
    rationale: z.string().optional(),
  }))
  .refine(data => data.message || data.rationale, {
    message: "Review must have a message or rationale",
    path: ["message"]
  })
  .transform(data => ({
    ...data,
    // 3. Polyfill for Aggregator
    message: data.message || data.rationale, // Ensure message always exists
    severity: data.severity || "suggestion"  // Ensure severity always exists
  }));

const ReviewSchema = z.object({
  reviews: z.array(ReviewItemSchema).optional(),
  issues: z.array(ReviewItemSchema).optional(), // Support 'issues' key used by some agents
  proposed_rules: z.array(z.object({
    id: z.string(),
    message: z.string(),
    language: z.string(),
    rule: z.any(),
    reason: z.string()
  })).optional()
})
.refine(data => data.reviews != null || data.issues != null, {
  message: "Agent response must include either 'reviews' or 'issues' array"
})
.transform(data => {
  // Normalize top-level key: 'issues' -> 'reviews'
  // Use explicit null/undefined checks to avoid treating empty arrays as falsy
  // Priority: prefer 'reviews' if it exists (even if empty array), otherwise use 'issues'
  const reviews = data.reviews != null ? data.reviews : (data.issues != null ? data.issues : undefined);
  return {
    ...data,
    reviews,
    issues: undefined 
  };
});

async function run() {
  try {
    console.log(`Starting review for agent: ${agentType}`);
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is missing");

    // 1. Get Diff
    const rawBaseRef = process.env.GITHUB_BASE_REF || "main";
    // Sanitize baseRef
    if (!/^[a-zA-Z0-9/._-]+$/.test(rawBaseRef)) {
      console.warn(`Invalid base ref: ${rawBaseRef}, defaulting to 'main'`);
    }
    const baseRef = /^[a-zA-Z0-9/._-]+$/.test(rawBaseRef) ? rawBaseRef : "main";

    let rawDiff;
    try {
      rawDiff = execSync(`git diff origin/${baseRef}...HEAD`, { 
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large diffs
      });
    } catch (_e) {
      console.error("Failed to get diff, using empty diff");
      rawDiff = "";
    }
    
    if (!rawDiff.trim()) {
      console.log("No diff found, skipping.");
      // Write empty report so artifact upload succeeds
      const emptyReport = { agent: agentType, reviews: [], issues: [], skipped: "no_diff" };
      fs.writeFileSync(`review-${agentType}.json`, JSON.stringify(emptyReport, null, 2));
      return;
    }

    // Filter Diff
    // We need to parse the diff and only keep sections for allowed files
    // Simplified approach: Split by file header, filter chunks, rejoin
    const chunks = rawDiff.split(/^diff --git /gm);
    // First chunk might be empty string if diff starts with "diff --git"
    const validChunks = chunks.filter(chunk => {
      if (!chunk.trim()) return false;
      // Extract filename from "a/path b/path"
      // Usually first line is "a/src/foo.ts b/src/foo.ts"
      const firstLine = chunk.split('\n')[0];
      const match = firstLine.match(/\sb\/(.+)$/);
      if (!match) return false;
      
      // Clean filename (remove newline/modifiers)
      const filename = match[1].trim();
      return shouldReviewFile(filename);
    });

    if (validChunks.length === 0) {
      console.log("No relevant files to review (filtered).");
      // Write empty report so artifact upload succeeds
      const emptyReport = { agent: agentType, reviews: [], issues: [], skipped: "no_relevant_files" };
      fs.writeFileSync(`review-${agentType}.json`, JSON.stringify(emptyReport, null, 2));
      return;
    }

    let diff = validChunks.map(c => "diff --git " + c).join('\n');

    // Truncate
    const MAX_CHARS = 60000; // Pro model handles more context
    if (diff.length > MAX_CHARS) {
      diff = diff.substring(0, MAX_CHARS) + "\n...[Truncated]...";
    }

    // 2. Read Context Files
    const rootDir = path.join(__dirname, "../..");
    const promptsDir = path.join(rootDir, ".github/prompts");
    
    // Read specific prompt for this agent
    const promptPath = path.join(promptsDir, `REVIEW_${agentType.toUpperCase()}.md`);
    let agentPrompt;
    
    if (!fs.existsSync(promptPath)) {
      console.warn(`Prompt file not found: ${promptPath}. Using default/general prompt.`);
      // Fallback to general if specific prompt is missing (prevents crash)
      const generalPromptPath = path.join(promptsDir, "REVIEW_GENERAL.md");
      if (fs.existsSync(generalPromptPath)) {
         agentPrompt = loadPrompt(generalPromptPath);
      } else {
         throw new Error(`Critical: No prompt files found at ${promptsDir}`);
      }
    } else {
      agentPrompt = loadPrompt(promptPath);
    }

    // Read AGENTS.md (Global Rules)
    const agentsMdPath = path.join(rootDir, "AGENTS.md");
    const agentsMd = fs.existsSync(agentsMdPath) ? fs.readFileSync(agentsMdPath, "utf-8") : "";

    // Read Extra Context for General/Architecture reviews
    let extraContext = "";
    if (agentType === "general" || agentType === "docs" || agentType === "contrarian" || agentType === "architect") {
      const archDocs = process.env.COUNCIL_ARCHITECTURE_DOCS 
        ? process.env.COUNCIL_ARCHITECTURE_DOCS.split(',').map(d => d.trim())
        : ["README.md"];
      
      archDocs.forEach(docPath => {
        const full = path.join(rootDir, docPath);
        if (fs.existsSync(full) && validateFilePath(docPath, rootDir)) {
          extraContext += `\n\n## ${docPath}\n${fs.readFileSync(full, "utf-8")}`;
        }
      });
    }

    // Cross-repo context for Architect agent (backend + infrastructure repos)
    if (agentType === "architect") {
      const maxCharsPerFile = 12000;
      const tryRead = (filePath) => {
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          return content.length > maxCharsPerFile ? content.substring(0, maxCharsPerFile) + "\n...[truncated]..." : content;
        } catch (_e) { return ""; }
      };
      const addFile = (dir, out, relPath) => {
        const full = path.join(dir, relPath);
        if (fs.existsSync(full) && fs.statSync(full).isFile() && validateFilePath(relPath, dir)) {
          out.content += `\n### ${relPath}\n${tryRead(full)}\n`;
        }
      };

      const backendDir = path.join(rootDir, "repos/backend");
      const infraDir = path.join(rootDir, "repos/infrastructure");

      // Backend: README, architecture docs, requirements.txt + module READMEs + key Python (core/, common/)
      if (fs.existsSync(backendDir) && fs.statSync(backendDir).isDirectory()) {
        const out = { content: "\n\n## Backend repo (repos/backend)\n" };
        ["README.md", "requirements.txt"].forEach(f => addFile(backendDir, out, f));
        
        // Add dynamic architecture docs based on the configured list
        const archDocs = process.env.COUNCIL_ARCHITECTURE_DOCS 
          ? process.env.COUNCIL_ARCHITECTURE_DOCS.split(',').map(d => d.trim())
          : ["README.md"];
        archDocs.forEach(docPath => {
           addFile(backendDir, out, docPath);
        });

        // README from each top-level subdir (cloud service / module)
        try {
          fs.readdirSync(backendDir, { withFileTypes: true }).forEach(e => {
            if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") return;
            const readmeRel = `${e.name}/README.md`;
            if (validateFilePath(readmeRel, backendDir)) addFile(backendDir, out, readmeRel);
          });
        } catch (_e) {}
        const pyCount = { n: 0 };
        const walkPy = (d, depth) => {
          if (depth <= 0 || pyCount.n >= 20) return;
          try {
            fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
              if (pyCount.n >= 20) return;
              const full = path.join(d, e.name);
              const rel = path.relative(backendDir, full);
              if (rel.startsWith("..") || e.name.startsWith(".") || e.name === "node_modules") return;
              if (e.isDirectory()) walkPy(full, depth - 1);
              else if (e.isFile() && e.name.endsWith(".py") && validateFilePath(rel, backendDir)) {
                addFile(backendDir, out, rel);
                pyCount.n++;
              }
            });
          } catch (_e) {}
        };
        walkPy(path.join(backendDir, "core"), 3);
        walkPy(path.join(backendDir, "common"), 2);
        extraContext += out.content;
      }

      // Infrastructure: README + .tf (root, then envs/dev, then modules)
      if (fs.existsSync(infraDir) && fs.statSync(infraDir).isDirectory()) {
        const out = { content: "\n\n## Infrastructure repo (repos/infrastructure)\n" };
        addFile(infraDir, out, "README.md");
        const tfPaths = [];
        const collectTf = (d, depth) => {
          if (depth <= 0 || tfPaths.length >= 25) return;
          try {
            fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
              const full = path.join(d, e.name);
              const rel = path.relative(infraDir, full);
              if (rel.startsWith("..") || e.name.startsWith(".")) return;
              if (e.isFile() && e.name.endsWith(".tf") && validateFilePath(rel, infraDir)) tfPaths.push(rel);
              else if (e.isDirectory()) collectTf(full, depth - 1);
            });
          } catch (_e) {}
        };
        collectTf(infraDir, 4);
        // Prefer root .tf, then envs/dev, then modules
        const sorted = tfPaths.sort((a, b) => {
          const ar = a.includes("envs/") ? 1 : a.includes("modules/") ? 2 : 0;
          const br = b.includes("envs/") ? 1 : b.includes("modules/") ? 2 : 0;
          return ar !== br ? ar - br : a.localeCompare(b);
        });
        sorted.slice(0, 20).forEach(rel => addFile(infraDir, out, rel));
        extraContext += out.content;
      }

      // PR-aware search: find files in other repos that mention PR-related tokens
      const searchTokens = extractSearchTokensFromDiff(diff);
      if (searchTokens.length > 0) {
        const backendRelevant = findFilesContainingTokens(backendDir, searchTokens, { maxFiles: 10, maxDepth: 5 });
        const infraRelevant = findFilesContainingTokens(infraDir, searchTokens, { maxFiles: 10, maxDepth: 5 });
        if (backendRelevant.length > 0 || infraRelevant.length > 0) {
          let searchSection = "\n\n## Relevant files in other repos (mention PR-related terms)\n";
          backendRelevant.forEach(rel => {
            if (validateFilePath(rel, backendDir)) searchSection += `\n### backend: ${rel}\n${tryRead(path.join(backendDir, rel))}\n`;
          });
          infraRelevant.forEach(rel => {
            if (validateFilePath(rel, infraDir)) searchSection += `\n### infrastructure: ${rel}\n${tryRead(path.join(infraDir, rel))}\n`;
          });
          extraContext += searchSection;
          console.log("Loaded cross-repo context: static snapshot + PR-relevant files (backend=" + backendRelevant.length + " infra=" + infraRelevant.length + ")");
        } else {
          console.log("Loaded cross-repo context: static snapshot only (no PR-relevant files found)");
        }
      } else {
        console.log("Loaded cross-repo context: static snapshot only (no search tokens from diff)");
      }
    }

    // Inject Rules for Governance Agent
    if (agentType === "governance") {
      const rulesDir = path.join(rootDir, "rules");
      if (fs.existsSync(rulesDir)) {
        const ruleFiles = fs.readdirSync(rulesDir).filter(f => f.endsWith(".yml"));
        let rulesContent = "";
        for (const ruleFile of ruleFiles) {
          rulesContent += `\n### ${ruleFile}\n${fs.readFileSync(path.join(rulesDir, ruleFile), "utf-8")}\n`;
        }
        if (rulesContent) {
           extraContext += `\n\n## CURRENT AST-GREP RULES (rules/*.yml)\n${rulesContent}`;
        }
      }
    }

    // 3. Prepare Function Calling (Tool Use) for Docs Agent
    // Note: For Gemini 3.0 models, we use the new googleSearch tool (not the legacy googleSearchRetrieval).
    // The new tool automatically decides when to search based on the prompt content.
    // Unlike the legacy tool, it doesn't support MODE_ALWAYS to force searches, but the model
    // is designed to search when it detects that fresh information would improve the answer.
    // We enhance the prompt (see REVIEW_DOCS.md) to encourage searches for documentation verification.
    // IMPORTANT: googleSearch is the CORRECT modern syntax. googleSearchRetrieval is deprecated.
    // See rules/gemini-google-search-tool.yml for governance documentation.
    let tools = [];
    if (agentType === "docs") {
      tools = [
        {
          googleSearch: {},
        }
      ];
    }

    // 4. Call Gemini with Retry
    // For docs agent: Enhance prompt to encourage web searches for API verification
    let searchEncouragement = "";
    if (agentType === "docs") {
      searchEncouragement = `

## SEARCH INSTRUCTIONS FOR DOCUMENTATION VERIFICATION
When reviewing code changes, you MUST use the Google Search tool to verify:
- API deprecations and breaking changes
- Correct usage of external libraries (Firebase, Next.js, Drizzle, etc.)
- Current best practices for any unfamiliar patterns
- Library version compatibility

The search tool is enabled and will automatically search when you need fresh information. Be proactive in identifying areas that require verification through web search.
`;
    }
    
    const fullPrompt = `
${agentPrompt}

## GLOBAL PROJECT RULES (AGENTS.md)
${agentsMd}

${extraContext}
${searchEncouragement}

## CODE CHANGES (DIFF)
${diff}

IMPORTANT: Please confirm you have read the changes and the rules.
Response must be valid JSON.
`;

    // Safety: Don't enforce JSON mode if tools are active, as it can interfere with Function Calling.
    // We rely on parseLlmJson to handle the output if it comes back as Markdown.
    const useJsonMode = tools.length === 0;

    console.log("Sending request to Gemini...");
    const responseText = await callGeminiWithRetry(apiKey, fullPrompt, {
      tools: tools.length > 0 ? tools : undefined,
      generationConfig: { 
        responseMimeType: useJsonMode ? "application/json" : undefined 
      }
    });

    // 5. Validate and Save Output
    // Ensure it parses
    let parsedJson;
    try {
      parsedJson = parseLlmJson(responseText);
    } catch (parseError) {
      throw new Error(`Failed to parse JSON response: ${parseError.message}`);
    }

    // Validate Schema (Security & Integrity)
    const validation = ReviewSchema.safeParse(parsedJson);
    if (!validation.success) {
      console.error("Schema validation failed:", JSON.stringify(validation.error.format(), null, 2));
      console.error("Raw JSON:", JSON.stringify(parsedJson, null, 2));
      throw new Error(`Schema validation failed. See logs for details.`);
    } else {
        // Use the validated data and add agent field for aggregator
        // Include 'issues' as alias for backward compatibility (failsafe for other consumers)
        parsedJson = {
          ...validation.data,
          agent: agentType,
          issues: validation.data.reviews // Backward compat alias (failsafe)
        };
    }

    const outputPath = `review-${agentType}.json`;
    const jsonContent = JSON.stringify(parsedJson, null, 2);
    fs.writeFileSync(outputPath, jsonContent);
    console.log(`Review saved to ${outputPath}`);

  } catch (error) {
    console.error(`Review failed for ${agentType}:`, error);
    // Write empty error report to avoid crashing the aggregation
    // Use normalized 'reviews' key (matches schema output) but include 'issues' for backward compatibility
    const errorReport = { 
      agent: agentType, 
      reviews: [], // Normalized key (matches schema output)
      issues: [],  // Backward compatibility for code expecting 'issues'
      error: error.message 
    };
    try {
      fs.writeFileSync(`review-${agentType}.json`, JSON.stringify(errorReport));
    } catch (writeError) {
      console.error(`Failed to write error report: ${writeError.message}`);
    }
    // Exit 0 so the aggregator step still runs (it will read the error from the JSON)
    process.exit(0);
  }
}

run().catch(e => {
  console.error("Unhandled error:", e);
  process.exit(1);
});

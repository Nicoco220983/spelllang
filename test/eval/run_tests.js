import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
    const args = process.argv.slice(2);
    const model = args.find(a => a.startsWith('--model='))?.split('=')[1];
    let thinking = args.find(a => a.startsWith('--thinking='))?.split('=')[1];
    if (args.includes('--no-thinking')) {
        thinking = 'none';
    }
    const isThinkingDisabled = thinking && ['none', 'off', 'false', '0'].includes(thinking.toLowerCase());

    const timeoutArg = args.find(a => a.startsWith('--timeout='))?.split('=')[1];
    const timeoutSec = timeoutArg ? parseInt(timeoutArg, 10) : 120; // Default 120s for thinking/reasoning models

    if (!model) {
        console.error('Error: --model argument is required. Example: --model=google/gemini-2.0-flash-001');
        process.exit(1);
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        console.error('Error: OPENROUTER_API_KEY environment variable is not set.');
        process.exit(1);
    }

    try {
        const promptPath = path.join(__dirname, 'prompt.md');
        const scenariosPath = path.join(__dirname, 'scenarios.json');

        const systemPrompt = await fs.readFile(promptPath, 'utf8');
        const scenarios = JSON.parse(await fs.readFile(scenariosPath, 'utf8'));

        const modelSlug = model.replace(/\//g, '_');
        let dirName = modelSlug;
        if (isThinkingDisabled) {
            dirName = `${modelSlug}_no-thinking`;
        } else if (thinking) {
            dirName = `${modelSlug}_thinking-${thinking.replace(/\//g, '_')}`;
        }
        const outputBaseDir = path.join(__dirname, 'output', dirName);
        await fs.mkdir(outputBaseDir, { recursive: true });

        console.log(`Starting tests for model: ${model}`);
        console.log(`Timeout: ${timeoutSec}s`);
        if (isThinkingDisabled) {
            console.log(`Thinking: DISABLED (enabled: false)`);
        } else if (thinking) {
            console.log(`Thinking level: ${thinking}`);
        }
        console.log(`Output directory: ${path.relative(process.cwd(), outputBaseDir) || outputBaseDir}`);

        for (const scenario of scenarios) {
            console.log(`\n--------------------------------------------`);
            console.log(`Running scenario: ${scenario.name}...`);
            console.log(`Description: ${scenario.description}`);

            const body = {
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Task: ${scenario.description}\n\nGenerate the spelllang script for this task.` }
                ]
            };

            // Handle thinking/reasoning if requested
            if (isThinkingDisabled) {
                body.reasoning = { enabled: false };
            } else if (thinking) {
                if (thinking === 'true') {
                    body.reasoning = { enabled: true };
                } else {
                    body.reasoning = { effort: thinking };
                }
            }

            console.log(`Sending request to OpenRouter for ${scenario.id}...`);
            const startTime = Date.now();

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutSec * 1000);

            try {
                const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': 'https://github.com/spelllang/spelllang',
                        'X-Title': 'spelllang Test Runner'
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal
                });

                const headersDuration = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`Headers received in ${headersDuration}s (Status: ${response.status}), waiting for completion...`);

                if (!response.ok) {
                    const error = await response.text();
                    console.error(`Failed to run scenario ${scenario.id}: ${response.status} ${error}`);
                    clearTimeout(timeoutId);
                    continue;
                }

                const data = await response.json();
                clearTimeout(timeoutId); // Clear timeout as soon as body is parsed successfully
                const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`Response received in ${totalDuration}s`);
                
                let content = data.choices[0].message.content;
                
                // Extract code from markdown blocks if the model didn't follow instructions perfectly
                if (content.includes('```')) {
                    const match = content.match(/```(?:spelllang|)\n?([\s\S]*?)```/);
                    if (match) content = match[1];
                }

                const outputPath = path.join(outputBaseDir, `${scenario.id}.spell`);
                await fs.writeFile(outputPath, content.trim());
                console.log(`  - Saved to ${outputPath}`);

                // Save reasoning if available
                const reasoning = data.choices[0].message.reasoning || data.choices[0].message.reasoning_content;
                if (reasoning) {
                    const reasoningPath = path.join(outputBaseDir, `${scenario.id}.reasoning.md`);
                    await fs.writeFile(reasoningPath, reasoning);
                    console.log(`  - Saved reasoning to ${reasoningPath}`);
                }
            } catch (err) {
                clearTimeout(timeoutId);
                const duration = ((Date.now() - startTime) / 1000).toFixed(1);
                if (err.name === 'AbortError') {
                    console.error(`Error: Request for scenario ${scenario.id} timed out after ${duration}s`);
                } else {
                    console.error(`Error processing scenario ${scenario.id}:`, err.message || err);
                }
            }
        }

        console.log('\nAll scenarios completed.');

    } catch (err) {
        console.error('An unexpected error occurred:', err);
    }
}

main();

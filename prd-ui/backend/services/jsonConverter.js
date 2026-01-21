/**
 * JSON Converter Service
 * Implements logic from skills/ralph/SKILL.md
 * Converts PRD markdown to prd.json format
 */

import { parsePRD, extractFeatureName } from '../utils/markdownParser.js';
import { spawn } from 'child_process';

/**
 * Check if Cursor CLI agent command is available
 */
async function isAgentAvailable() {
  return new Promise((resolve) => {
    const child = spawn('agent', ['--version'], { 
      shell: false,
      stdio: 'ignore'
    });
    
    const timeoutId = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 5000);
    
    child.on('close', (code) => {
      clearTimeout(timeoutId);
      resolve(code === 0);
    });
    
    child.on('error', () => {
      clearTimeout(timeoutId);
      resolve(false);
    });
  });
}

/**
 * Build prompt for Cursor CLI agent to convert PRD to JSON
 */
function buildJSONConversionPrompt(markdown, projectName) {
  let prompt = `Convert this PRD to prd.json format for the Ralph autonomous agent system.\n\n`;
  prompt += `Project Name: ${projectName}\n\n`;
  prompt += `PRD Markdown:\n${markdown}\n\n`;
  prompt += `Please convert this PRD to the prd.json format following the structure in skills/ralph/SKILL.md. `;
  prompt += `The output JSON MUST include these top-level fields: "project" (use "${projectName}"), "branchName" (format: "ralph/[feature-name-kebab-case]" derived from PRD title), "description", and "userStories". `;
  prompt += `Each user story object in the userStories array MUST have ALL of these fields: "id" (string, format: "US-001"), "title" (string), "description" (string), "acceptanceCriteria" (array of strings), "priority" (number, 1-based ordering), "passes" (boolean, set to false), and "notes" (string, can be empty). `;
  prompt += `IMPORTANT: Every story's acceptanceCriteria array MUST include "Typecheck passes" as one of the criteria. If it's not in the PRD, add it automatically. `;
  prompt += `Stories should be ordered by dependencies (schema -> backend -> UI). `;
  prompt += `\n\nCRITICAL OUTPUT INSTRUCTIONS:\n`;
  prompt += `- Output ONLY the raw JSON object, nothing else\n`;
  prompt += `- Do NOT wrap in markdown code fences\n`;
  prompt += `- Do NOT include any explanatory text before or after\n`;
  prompt += `- Do NOT save to any file\n`;
  prompt += `- The response must start with { and end with }\n`;
  
  return prompt;
}

/**
 * Extract JSON from agent output
 * Handles both wrapped (--output-format json) and unwrapped responses
 * @param {string} output - The raw output from the agent command
 * @returns {object} The extracted and parsed JSON object
 */
export function extractJSONFromOutput(output) {
  if (!output || typeof output !== 'string') {
    throw new Error('Invalid output: empty or not a string');
  }
  
  // Trim whitespace
  const trimmedOutput = output.trim();
  
  if (!trimmedOutput) {
    throw new Error('Invalid output: empty after trimming');
  }
  
  // Step 1: Try to parse output as JSON (might be the metadata wrapper)
  try {
    const parsed = JSON.parse(trimmedOutput);
    
    // If it's the agent metadata wrapper with a 'result' field
    if (parsed.result !== undefined) {
      if (typeof parsed.result === 'string') {
        return extractJSONFromString(parsed.result);
      }
      // Result might be a nested object
      if (typeof parsed.result === 'object' && parsed.result !== null) {
        if (parsed.result.project || parsed.result.branchName || parsed.result.userStories) {
          return parsed.result;
        }
      }
    }
    
    // Check for 'output' field (some agent versions use this)
    if (parsed.output !== undefined) {
      if (typeof parsed.output === 'string') {
        return extractJSONFromString(parsed.output);
      }
      if (typeof parsed.output === 'object' && parsed.output !== null) {
        if (parsed.output.project || parsed.output.branchName || parsed.output.userStories) {
          return parsed.output;
        }
      }
    }
    
    // If it's already the PRD JSON (has project, branchName, userStories)
    if (parsed.project || parsed.branchName || parsed.userStories) {
      return parsed;
    }
    
    // Check if there's a nested structure we should extract from
    for (const key of Object.keys(parsed)) {
      const value = parsed[key];
      if (typeof value === 'object' && value !== null) {
        if (value.project || value.branchName || value.userStories) {
          return value;
        }
      }
    }
    
    // Otherwise, it might be wrapped differently - try to extract from any string field
    for (const key of Object.keys(parsed)) {
      const value = parsed[key];
      if (typeof value === 'string' && value.includes('{') && value.includes('userStories')) {
        try {
          return extractJSONFromString(value);
        } catch (e) {
          // Continue
        }
      }
    }
    
    // Last resort: return parsed as-is
    return parsed;
  } catch (e) {
    // Not valid JSON, try extracting from text
    return extractJSONFromString(trimmedOutput);
  }
}

/**
 * Extract JSON from a string that might contain markdown code fences or mixed content
 */
function extractJSONFromString(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid text input for JSON extraction');
  }

  // Normalize the text (handle escaped newlines, etc.)
  let normalizedText = text.replace(/\\n/g, '\n').replace(/\\"/g, '"');
  
  // Strip common prefixes like "Here's the JSON:" or "Here is the converted PRD:"
  normalizedText = normalizedText.replace(/^[\s\S]*?(?=\{|```)/m, '');
  
  // Try to extract from markdown code fence first (```json ... ```)
  const markdownMatch = normalizedText.match(/```json\s*\n?([\s\S]*?)\n?```/);
  if (markdownMatch) {
    try {
      return JSON.parse(markdownMatch[1].trim());
    } catch (e) {
      console.log('[JSON Extraction] Found ```json fence but failed to parse:', e.message);
    }
  }
  
  // Try to extract from any code fence (``` ... ```)
  const codeMatch = normalizedText.match(/```\s*\n?([\s\S]*?)\n?```/);
  if (codeMatch) {
    try {
      return JSON.parse(codeMatch[1].trim());
    } catch (e) {
      console.log('[JSON Extraction] Found code fence but failed to parse:', e.message);
    }
  }
  
  // Try to find the largest balanced JSON object containing userStories
  const firstBrace = normalizedText.indexOf('{');
  if (firstBrace !== -1) {
    // Find all balanced JSON objects and pick the one with userStories
    let depth = 0;
    let startIdx = -1;
    let candidates = [];
    
    for (let i = firstBrace; i < normalizedText.length; i++) {
      if (normalizedText[i] === '{') {
        if (depth === 0) startIdx = i;
        depth++;
      }
      if (normalizedText[i] === '}') {
        depth--;
        if (depth === 0 && startIdx !== -1) {
          const jsonStr = normalizedText.substring(startIdx, i + 1);
          try {
            const parsed = JSON.parse(jsonStr);
            // Check if this looks like our PRD format
            if (parsed.userStories || parsed.project || parsed.branchName) {
              return parsed;
            }
            candidates.push({ parsed, length: jsonStr.length });
          } catch (e) {
            // Not valid JSON, continue
          }
          startIdx = -1;
        }
      }
    }
    
    // If we found any valid JSON objects, return the largest one
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.length - a.length);
      return candidates[0].parsed;
    }
  }
  
  // Try to find JSON object with "project" field (our specific format)
  const projectMatch = normalizedText.match(/\{[^{}]*"project"[^{}]*"userStories"\s*:\s*\[[\s\S]*?\]\s*\}/);
  if (projectMatch) {
    try {
      return JSON.parse(projectMatch[0]);
    } catch (e) {
      console.log('[JSON Extraction] Found project/userStories pattern but failed to parse');
    }
  }
  
  // Last resort: try parsing the whole text
  try {
    return JSON.parse(normalizedText.trim());
  } catch (e) {
    throw new Error('Could not extract valid JSON from agent output');
  }
}

/**
 * Execute Cursor CLI agent command using spawn for proper argument handling
 * Avoids all shell escaping issues by passing arguments directly to the process
 * @param {string} prompt - The prompt to send to the agent
 * @param {string} outputFormat - The output format (text or json)
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export async function execAgentCommand(prompt, outputFormat = 'json', timeout = 120000) {
  return new Promise((resolve, reject) => {
    const args = ['--print', '--force', '--output-format', outputFormat, prompt];
    
    const child = spawn('agent', args, { 
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    let timeoutId;
    
    // Set up timeout
    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Command timeout'));
      }, timeout);
    }
    
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    child.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed with exit code ${code}${stderr ? ': ' + stderr : ''}`));
      }
    });
    
    child.on('error', (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      reject(error);
    });
  });
}

/**
 * Convert PRD to JSON using Cursor CLI agent
 */
async function convertPRDToJSONWithAgent(markdown, projectName, updateProgress = null) {
  const log = (status, message) => {
    if (updateProgress) updateProgress(status, message);
  };

  log('building', 'Building prompt for Cursor CLI agent...');
  const prompt = buildJSONConversionPrompt(markdown, projectName);
  
  try {
    log('executing', 'Executing Cursor CLI agent command...');
    // --print flag is required to enable shell execution (bash access)
    // --force flag forces allow commands unless explicitly denied
    // Use spawn to avoid shell escaping issues with long prompts
    log('waiting', 'Waiting for agent response (this may take 60-180 seconds)...');
    
    // Use 'text' output format - 'json' wraps in metadata which conflicts with our PRD JSON
    // Increased timeout to 180 seconds (3 min) for larger PRDs
    const { stdout, stderr } = await execAgentCommand(prompt, 'text', 180000);
    
    log('parsing', 'Parsing agent output...');
    
    // Debug: Log raw output info (truncated for readability)
    const outputPreview = stdout.length > 500 ? stdout.substring(0, 500) + '...[truncated]' : stdout;
    console.log('[JSON Conversion] Raw agent output length:', stdout.length);
    console.log('[JSON Conversion] Raw agent output preview:', outputPreview);
    
    // Check for truncated JSON (common issue with large PRDs)
    const trimmedOutput = stdout.trim();
    if (trimmedOutput.startsWith('{') && !trimmedOutput.endsWith('}')) {
      // Count braces to confirm truncation
      const openBraces = (trimmedOutput.match(/\{/g) || []).length;
      const closeBraces = (trimmedOutput.match(/\}/g) || []).length;
      if (openBraces > closeBraces) {
        console.error('[JSON Conversion] TRUNCATED JSON DETECTED');
        console.error(`[JSON Conversion] Open braces: ${openBraces}, Close braces: ${closeBraces}`);
        console.error('[JSON Conversion] Output ends with:', trimmedOutput.substring(Math.max(0, trimmedOutput.length - 100)));
        throw new Error(`JSON response was truncated (${openBraces} open braces, ${closeBraces} close braces). The PRD may be too large. Try simplifying the PRD or reducing the number of user stories.`);
      }
    }
    
    try {
      const json = extractJSONFromOutput(stdout);
      
      // Validate the JSON structure
      const validation = validateJSON(json);
      if (!validation.valid) {
        throw new Error(`Invalid JSON structure: ${validation.errors.join(', ')}`);
      }
      
      log('complete', 'JSON extracted and validated');
      return json;
    } catch (extractError) {
      // Log more details about what we received
      console.error('[JSON Conversion] Failed to extract JSON from output');
      console.error('[JSON Conversion] Output starts with:', stdout.substring(0, 200));
      console.error('[JSON Conversion] Output ends with:', stdout.substring(Math.max(0, stdout.length - 200)));
      console.error('[JSON Conversion] Contains "userStories":', stdout.includes('userStories'));
      console.error('[JSON Conversion] Contains "project":', stdout.includes('"project"'));
      console.error('[JSON Conversion] Contains code fence:', stdout.includes('```'));
      throw extractError;
    }
  } catch (error) {
    log('error', `Agent conversion failed: ${error.message}`);
    console.error('Agent conversion failed:', error.message);
    if (error.stderr) {
      console.error('Agent stderr:', error.stderr);
    }
    throw error;
  }
}

/**
 * Convert PRD markdown to JSON format
 * Uses Cursor CLI agent if available, otherwise uses template-based conversion
 * 
 * @param {Function} progressCallback - Optional callback for progress updates
 */
export async function convertPRDToJSON(markdown, projectName = 'Project', progressCallback = null) {
  const updateProgress = (status, message) => {
    if (progressCallback) {
      progressCallback({ status, message, timestamp: new Date().toISOString() });
    }
    console.log(`[JSON Conversion] ${status}: ${message}`);
  };

  updateProgress('checking', 'Checking if Cursor CLI agent is available...');
  
  // Try to use agent first if available
  const agentAvailable = await isAgentAvailable();
  
  if (agentAvailable) {
    updateProgress('generating', 'Using Cursor CLI agent to convert PRD to JSON...');
    try {
      const result = await convertPRDToJSONWithAgent(markdown, projectName, updateProgress);
      // Note: convertPRDToJSONWithAgent already logs 'complete' status via updateProgress callback
      return result;
    } catch (error) {
      // Fallback to template conversion
      updateProgress('fallback', `Agent conversion failed, using template: ${error.message}`);
      console.warn('Falling back to template conversion:', error.message);
      try {
        const templateResult = convertPRDToJSONTemplate(markdown, projectName);
        console.log('[JSON Conversion] Template conversion finished, stories:', templateResult.userStories?.length || 0);
        updateProgress('complete', `Template conversion completed (${templateResult.userStories?.length || 0} user stories)`);
        return templateResult;
      } catch (templateError) {
        console.error('[JSON Conversion] Template conversion also failed:', templateError);
        updateProgress('error', `Template conversion failed: ${templateError.message}`);
        throw templateError;
      }
    }
  } else {
    // Agent not available, use template conversion
    updateProgress('template', 'Cursor CLI not available, using template conversion...');
    return convertPRDToJSONTemplate(markdown, projectName);
  }
}

/**
 * Convert PRD markdown to JSON format using template-based approach (fallback)
 */
function convertPRDToJSONTemplate(markdown, projectName = 'Project') {
  console.log('[JSON Conversion] Starting template conversion...');
  console.log('[JSON Conversion] Markdown length:', markdown?.length || 0);
  
  const parsed = parsePRD(markdown);
  console.log('[JSON Conversion] Parsed PRD title:', parsed.title);
  console.log('[JSON Conversion] Parsed user stories count:', parsed.userStories?.length || 0);
  
  // Extract feature name from title
  const featureName = extractFeatureName(parsed.title || 'feature');
  const branchName = `ralph/${featureName}`;
  console.log('[JSON Conversion] Generated branch name:', branchName);

  // Convert user stories
  const userStories = parsed.userStories.map((story, index) => {
    // Ensure "Typecheck passes" is in acceptance criteria
    let criteria = [...story.acceptanceCriteria];
    const hasTypecheck = criteria.some(c => 
      c.toLowerCase().includes('typecheck') || 
      c.toLowerCase().includes('type check')
    );
    
    if (!hasTypecheck) {
      criteria.push('Typecheck passes');
    }

    return {
      id: story.id || `US-${String(index + 1).padStart(3, '0')}`,
      title: story.title || 'Untitled story',
      description: story.description || story.title || '',
      acceptanceCriteria: criteria,
      priority: determinePriority(story, index, parsed.userStories),
      passes: false,
      notes: ''
    };
  });

  // Validate story sizes
  validateStorySizes(userStories);

  // Order stories by dependencies
  const orderedStories = orderStoriesByDependencies(userStories);

  return {
    project: projectName,
    branchName: branchName,
    description: parsed.introduction || parsed.title || `Feature: ${featureName}`,
    userStories: orderedStories
  };
}

/**
 * Determine priority based on story content and position
 * Stories about schema/database come first, then backend, then UI
 */
function determinePriority(story, index, allStories) {
  const title = (story.title || '').toLowerCase();
  const description = (story.description || '').toLowerCase();

  // Database/schema changes get highest priority
  if (
    title.includes('database') ||
    title.includes('schema') ||
    title.includes('table') ||
    title.includes('migration') ||
    description.includes('database') ||
    description.includes('schema')
  ) {
    return 1;
  }

  // Backend/API changes get medium-high priority
  if (
    title.includes('api') ||
    title.includes('backend') ||
    title.includes('server') ||
    title.includes('service') ||
    description.includes('api') ||
    description.includes('backend')
  ) {
    return Math.min(2, allStories.length);
  }

  // UI changes get lower priority
  if (
    title.includes('ui') ||
    title.includes('component') ||
    title.includes('page') ||
    title.includes('display') ||
    title.includes('show') ||
    description.includes('ui') ||
    description.includes('component')
  ) {
    return Math.min(index + 2, allStories.length);
  }

  // Default: use index + 1
  return index + 1;
}

/**
 * Validate that stories are small enough to complete in one iteration
 */
function validateStorySizes(stories) {
  const warnings = [];

  stories.forEach((story, index) => {
    const title = story.title.toLowerCase();
    const description = story.description.toLowerCase();
    const criteriaCount = story.acceptanceCriteria.length;

    // Check for overly broad titles
    const broadTerms = [
      'entire',
      'complete',
      'full',
      'all',
      'everything',
      'whole system',
      'refactor'
    ];

    const isTooBroad = broadTerms.some(term => 
      title.includes(term) || description.includes(term)
    );

    if (isTooBroad) {
      warnings.push({
        storyId: story.id,
        issue: 'Story title/description suggests it may be too large',
        suggestion: 'Consider splitting into smaller stories'
      });
    }

    // Check for too many acceptance criteria (suggests complexity)
    if (criteriaCount > 8) {
      warnings.push({
        storyId: story.id,
        issue: `Story has ${criteriaCount} acceptance criteria, which may be too many`,
        suggestion: 'Consider splitting into smaller, focused stories'
      });
    }
  });

  return warnings;
}

/**
 * Order stories by dependencies
 * Schema -> Backend -> UI -> Dashboard
 */
function orderStoriesByDependencies(stories) {
  // Categorize stories
  const schemaStories = [];
  const backendStories = [];
  const uiStories = [];
  const otherStories = [];

  stories.forEach(story => {
    const title = story.title.toLowerCase();
    const description = story.description.toLowerCase();

    if (
      title.includes('database') ||
      title.includes('schema') ||
      title.includes('table') ||
      title.includes('migration') ||
      description.includes('database') ||
      description.includes('schema')
    ) {
      schemaStories.push(story);
    } else if (
      title.includes('api') ||
      title.includes('backend') ||
      title.includes('server') ||
      title.includes('service') ||
      description.includes('api') ||
      description.includes('backend')
    ) {
      backendStories.push(story);
    } else if (
      title.includes('ui') ||
      title.includes('component') ||
      title.includes('page') ||
      title.includes('display') ||
      title.includes('show') ||
      title.includes('filter') ||
      title.includes('dropdown') ||
      description.includes('ui') ||
      description.includes('component')
    ) {
      uiStories.push(story);
    } else {
      otherStories.push(story);
    }
  });

  // Reorder and reassign priorities
  const ordered = [...schemaStories, ...backendStories, ...uiStories, ...otherStories];
  
  ordered.forEach((story, index) => {
    story.priority = index + 1;
  });

  return ordered;
}

/**
 * Validate the converted JSON structure
 */
export function validateJSON(json) {
  const errors = [];

  if (!json.project) {
    errors.push('Missing project name');
  }

  if (!json.branchName) {
    errors.push('Missing branch name');
  }

  if (!Array.isArray(json.userStories) || json.userStories.length === 0) {
    errors.push('No user stories found');
  }

  json.userStories?.forEach((story, index) => {
    if (!story.id) {
      errors.push(`Story ${index + 1} missing ID`);
    }
    if (!story.title) {
      errors.push(`Story ${index + 1} missing title`);
    }
    if (!Array.isArray(story.acceptanceCriteria) || story.acceptanceCriteria.length === 0) {
      errors.push(`Story ${index + 1} missing acceptance criteria`);
    }
    if (typeof story.priority !== 'number') {
      errors.push(`Story ${index + 1} missing priority`);
    }
  });

  return {
    valid: errors.length === 0,
    errors
  };
}

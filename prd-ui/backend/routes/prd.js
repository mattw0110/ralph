import express from 'express';
import fileService from '../services/fileService.js';
import { generateQuestions, generatePRD } from '../services/prdGenerator.js';
import { validateProjectPath, validateFeatureName } from '../utils/validation.js';

const router = express.Router();

/**
 * Generate clarifying questions
 * POST /api/prd/generate-questions
 */
router.post('/generate-questions', (req, res, next) => {
  try {
    const { featureDescription } = req.body;

    if (!featureDescription) {
      return res.status(400).json({ error: 'Feature description is required' });
    }

    const questions = generateQuestions(featureDescription);
    
    res.json({ questions });
  } catch (error) {
    next(error);
  }
});

/**
 * Generate PRD markdown content
 * POST /api/prd/generate
 */
router.post('/generate', async (req, res, next) => {
  try {
    const { featureDescription, answers, projectName, useSSE } = req.body;

    if (!featureDescription) {
      return res.status(400).json({ error: 'Feature description is required' });
    }

    if (!answers) {
      return res.status(400).json({ error: 'Answers are required' });
    }

    // If SSE requested, use streaming response
    if (useSSE) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const progressCallback = (progress) => {
        res.write(`data: ${JSON.stringify(progress)}\n\n`);
      };

      try {
        const prdContent = await generatePRD(
          featureDescription,
          answers,
          projectName || 'Project',
          progressCallback
        );
        
        res.write(`data: ${JSON.stringify({ status: 'done', content: prdContent })}\n\n`);
        res.end();
      } catch (error) {
        res.write(`data: ${JSON.stringify({ status: 'error', error: error.message })}\n\n`);
        res.end();
      }
      return;
    }

    // Regular non-streaming response
    const progressMessages = [];
    const progressCallback = (progress) => {
      progressMessages.push(progress);
    };

    const prdContent = await generatePRD(
      featureDescription,
      answers,
      projectName || 'Project',
      progressCallback
    );
    
    res.json({ 
      content: prdContent,
      progress: progressMessages // Include progress history for debugging
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Create PRD markdown file
 * POST /api/prd/create
 */
router.post('/create', async (req, res, next) => {
  try {
    const { projectPath, featureName, answers, prdContent, projectName } = req.body;

    if (!projectPath) {
      return res.status(400).json({ error: 'Project path is required' });
    }

    if (!featureName) {
      return res.status(400).json({ error: 'Feature name is required' });
    }

    validateProjectPath(projectPath);
    validateFeatureName(featureName);

    // Generate PRD if content not provided
    let content = prdContent;
    if (!content) {
      if (!answers) {
        return res.status(400).json({ error: 'Either prdContent or answers are required' });
      }
      content = await generatePRD(
        answers.featureDescription || featureName,
        answers,
        projectName || 'Project'
      );
    }

    const filePath = await fileService.savePRD(projectPath, featureName, content);
    
    res.json({
      success: true,
      filePath,
      featureName
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Read existing PRD file
 * GET /api/prd/read?projectPath=...&featureName=...
 */
router.get('/read', async (req, res, next) => {
  try {
    const { projectPath, featureName } = req.query;

    if (!projectPath || !featureName) {
      return res.status(400).json({ error: 'Project path and feature name are required' });
    }

    const content = await fileService.readPRD(projectPath, featureName);
    
    res.json({
      content,
      featureName
    });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

/**
 * Update existing PRD file
 * PUT /api/prd/update
 */
router.put('/update', async (req, res, next) => {
  try {
    const { projectPath, featureName, content } = req.body;

    if (!projectPath || !featureName || !content) {
      return res.status(400).json({ error: 'Project path, feature name, and content are required' });
    }

    validateProjectPath(projectPath);
    validateFeatureName(featureName);

    const filePath = await fileService.savePRD(projectPath, featureName, content);
    
    res.json({
      success: true,
      filePath,
      featureName
    });
  } catch (error) {
    next(error);
  }
});

export default router;

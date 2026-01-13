import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { prdApi } from '../../services/api';
import type { Question } from '../../types/prd';
import './PRDEditor.css';

interface PRDEditorProps {
  featureDescription: string;
  answers: Record<string, string>;
  questions: Question[];
  projectName?: string;
  onSubmit: (content: string) => void;
  onBack: () => void;
}

export default function PRDEditor({
  featureDescription,
  answers,
  questions,
  projectName,
  onSubmit,
  onBack
}: PRDEditorProps) {
  const [content, setContent] = useState('');
  const [generating, setGenerating] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progressStatus, setProgressStatus] = useState<string>('Initializing...');
  const [progressMessage, setProgressMessage] = useState<string>('');

  useEffect(() => {
    generatePRDContent();
  }, []);

  const generatePRDContent = async () => {
    setGenerating(true);
    setError(null);
    setProgressStatus('Starting...');
    setProgressMessage('Preparing to generate PRD...');
    
    try {
      // Use SSE for real-time progress updates
      const response = await fetch('/api/prd/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          featureDescription,
          answers,
          projectName: projectName || 'Project',
          useSSE: true
        })
      });

      if (!response.ok) {
        throw new Error('Failed to generate PRD');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error('No response body');
      }

      let buffer = '';
      let finalContent = '';

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              
              if (data.status === 'done' && data.content) {
                finalContent = data.content;
                setProgressStatus('Complete');
                setProgressMessage('PRD generated successfully!');
              } else if (data.status === 'error') {
                throw new Error(data.error || 'Generation failed');
              } else if (data.status && data.message) {
                setProgressStatus(data.status);
                setProgressMessage(data.message);
              }
            } catch (e) {
              // Ignore JSON parse errors for non-data lines
            }
          }
        }
      }

      if (finalContent) {
        setContent(finalContent);
      } else {
        throw new Error('No content received');
      }
    } catch (err: any) {
      console.error('Failed to generate PRD:', err);
      setError(err.message || 'Failed to generate PRD. Please try again.');
      setContent('# PRD\n\nError generating PRD. Please try again.');
      setProgressStatus('Error');
      setProgressMessage(err.message || 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(content);
  };

  if (generating) {
    return (
      <div className="prd-editor">
        <div className="card">
          <h2>Generating PRD...</h2>
          <div className="progress-container">
            <div className="progress-status">
              <strong>Status:</strong> {progressStatus}
            </div>
            <div className="progress-message">
              {progressMessage}
            </div>
            <div className="progress-spinner">
              <div className="spinner"></div>
            </div>
            <div className="progress-note">
              This may take 30-120 seconds when using Cursor CLI agent...
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="prd-editor">
      <div className="card">
        <h2>Review and Edit PRD</h2>
        {error && (
          <div className="error-message" style={{ marginBottom: '1rem', color: '#e74c3c' }}>
            {error}
          </div>
        )}
        <div className="editor-container">
          <div className="editor-panel">
            <label>Markdown Editor</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="markdown-editor"
              rows={20}
            />
          </div>
          <div className="preview-panel">
            <label>Preview</label>
            <div className="markdown-preview">
              <ReactMarkdown>{content}</ReactMarkdown>
            </div>
          </div>
        </div>
        <div className="form-actions">
          <button type="button" onClick={onBack}>Back</button>
          <button type="button" onClick={generatePRDContent}>Regenerate</button>
          <button type="submit" onClick={handleSubmit}>Next: Save</button>
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect, useRef } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { convertApi } from '../../services/api';
import type { PRDJSON } from '../../types/prd';
import './JSONPreview.css';

interface JSONPreviewProps {
  projectPath: string;
  prdContent: string;
  selectedPRD: string;
  onJSONGenerated: (json: PRDJSON) => void;
  onBack: () => void;
  onProjectNameChange: (name: string) => void;
}

export default function JSONPreview({
  projectPath,
  prdContent,
  selectedPRD,
  onJSONGenerated,
  onBack,
  onProjectNameChange
}: JSONPreviewProps) {
  const [jsonData, setJsonData] = useState<PRDJSON | null>(null);
  const [projectName, setProjectName] = useState('');
  const [converting, setConverting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<any>(null);
  const [progressStatus, setProgressStatus] = useState<string>('Initializing...');
  const [progressMessage, setProgressMessage] = useState<string>('');
  
  // Prevent duplicate conversions (React StrictMode double-invokes effects)
  const conversionInProgress = useRef(false);
  const lastConvertedContent = useRef<string>('');

  useEffect(() => {
    // Skip if already converting or if content hasn't changed
    if (conversionInProgress.current || lastConvertedContent.current === prdContent) {
      return;
    }
    convertPRD();
  }, [prdContent, projectPath]);

  const convertPRD = async () => {
    // Prevent duplicate calls
    if (conversionInProgress.current) {
      console.log('[JSONPreview] Conversion already in progress, skipping');
      return;
    }
    
    conversionInProgress.current = true;
    lastConvertedContent.current = prdContent;
    
    setConverting(true);
    setError(null);
    setProgressStatus('Starting...');
    setProgressMessage('Preparing to convert PRD to JSON...');
    
    try {
      // Use SSE for real-time progress updates
      const response = await fetch('/api/convert', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          projectPath,
          prdContent,
          projectName: projectName || undefined,
          useSSE: true
        })
      });

      if (!response.ok) {
        throw new Error('Failed to convert PRD');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error('No response body');
      }

      let buffer = '';
      let finalJson: PRDJSON | null = null;
      let finalValidation: any = null;

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
              
              if (data.status === 'done' && data.json) {
                finalJson = data.json;
                finalValidation = data.validation;
                setProgressStatus('Complete');
                setProgressMessage('JSON conversion completed successfully!');
              } else if (data.status === 'error') {
                throw new Error(data.error || 'Conversion failed');
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

      if (finalJson) {
        setJsonData(finalJson);
        setValidation(finalValidation);
        onProjectNameChange(finalJson.project);
      } else {
        throw new Error('No JSON received');
      }
    } catch (err: any) {
      console.error('Failed to convert PRD:', err);
      setError(err.message || 'Failed to convert PRD');
      setProgressStatus('Error');
      setProgressMessage(err.message || 'Conversion failed');
    } finally {
      setConverting(false);
      conversionInProgress.current = false;
    }
  };

  const handleProjectNameChange = (name: string) => {
    setProjectName(name);
    onProjectNameChange(name);
  };

  const handleNext = () => {
    if (jsonData) {
      onJSONGenerated(jsonData);
    }
  };

  if (converting) {
    return (
      <div className="json-preview">
        <div className="card">
          <h2>Converting PRD to JSON...</h2>
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
              This may take 60-180 seconds when using Cursor CLI agent...
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="json-preview">
        <div className="card">
          <div className="error-message">{error}</div>
          <button onClick={convertPRD}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="json-preview">
      <div className="card">
        <h2>Preview JSON</h2>

        <div className="form-group">
          <label htmlFor="project-name">Project Name</label>
          <input
            id="project-name"
            type="text"
            value={projectName || jsonData?.project || ''}
            onChange={(e) => handleProjectNameChange(e.target.value)}
            placeholder="Project name"
          />
          <small className="field-help">
            This becomes the "project" field in prd.json. Ralph uses this for project context. 
            The branchName is automatically generated as "ralph/[feature-name]" from the PRD title.
          </small>
        </div>

        {validation && !validation.valid && (
          <div className="validation-warnings">
            <h3>Validation Warnings</h3>
            <ul>
              {validation.errors?.map((err: string, i: number) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        {jsonData && (
          <div className="json-container">
            <SyntaxHighlighter
              language="json"
              style={vscDarkPlus}
              customStyle={{
                borderRadius: '4px',
                padding: '1rem',
                fontSize: '0.9rem'
              }}
            >
              {JSON.stringify(jsonData, null, 2)}
            </SyntaxHighlighter>
          </div>
        )}

        <div className="form-actions">
          <button type="button" onClick={onBack}>Back</button>
          <button type="button" onClick={convertPRD}>Regenerate</button>
          <button
            type="button"
            onClick={handleNext}
            disabled={!jsonData || (validation && !validation.valid)}
          >
            Next: Save
          </button>
        </div>
      </div>
    </div>
  );
}

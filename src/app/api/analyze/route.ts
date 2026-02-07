import { NextRequest, NextResponse } from 'next/server';
import { AnalysisResult } from '@/types/analysis';

// Ollama configuration
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llava';

// System prompt for dog behavior analysis
const SYSTEM_PROMPT = `You are an expert animal behavior analyst specializing in canine behavior.

Analyze the provided image of a dog and assess its observable behavior, emotional state, and possible health indicators based strictly on visible cues.

Focus on:
- Body posture (tail, ears, stance, tension)
- Facial expressions (eyes, mouth, panting, yawning)
- Movement patterns (pace, stiffness, restlessness, lethargy)
- Vocalization (if visible or implied)
- Interaction with environment or humans

IMPORTANT RULES:
1. Do NOT make medical diagnoses
2. If evidence is insufficient, say so clearly
3. Base conclusions only on visible behavior in the images
4. Use cautious language (e.g., "may indicate", "could suggest")
5. If behavior is ambiguous, state uncertainty

You MUST respond with ONLY a valid JSON object (no markdown, no extra text) matching this exact structure:
{
  "behaviorSummary": "Brief overall description of what the dog is doing",
  "observedBehaviors": [
    {
      "category": "Body Posture | Facial Expression | Movement | Vocalization | Interaction",
      "observation": "What you observe",
      "significance": "What this typically indicates"
    }
  ],
  "emotionalStates": [
    {
      "state": "e.g., Relaxed, Anxious, Playful, Stressed, Fearful, Alert, Curious",
      "confidence": "Low | Medium | High",
      "explanation": "Why you inferred this state"
    }
  ],
  "primaryMood": "The most likely overall mood",
  "stressIndicators": {
    "status": "Present | Not Present | Unclear",
    "details": ["List of specific stress signs if present"]
  },
  "healthIndicators": [
    {
      "indicator": "e.g., Limping, Excessive panting, Stiffness",
      "status": "Present | Not Present | Unclear",
      "details": "Description of what you observed",
      "severity": "Low | Medium | High"
    }
  ],
  "overallConfidence": "Low | Medium | High",
  "confidenceScore": 0.0 to 1.0,
  "notes": ["Additional observations"],
  "uncertainties": ["Things you couldn't determine"],
  "recommendations": ["Suggestions for the owner, if any"]
}`;

// Extract frames from video using canvas (simulated - in production use ffmpeg)
async function extractFramesFromVideo(videoBuffer: Buffer): Promise<string[]> {
  // For the hackathon demo, we'll convert the video to base64
  // In production, you'd use ffmpeg to extract actual frames
  const base64Video = videoBuffer.toString('base64');
  
  // Return the video as a single "frame" for now
  return [base64Video];
}

// Analyze frames using Ollama Vision API (LLaVA)
async function analyzeWithVision(frames: string[], mimeType: string): Promise<AnalysisResult> {
  // Use the first frame for analysis
  const imageBase64 = frames[0];

  const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: `${SYSTEM_PROMPT}\n\nAnalyze this image of a dog and provide a comprehensive behavioral assessment. Look for body language, emotional cues, and any potential health indicators. Remember to respond with ONLY valid JSON.`,
      images: [imageBase64],
      stream: false,
      options: {
        temperature: 0.7,
        num_predict: 2000,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const content = data.response;
  
  if (!content) {
    throw new Error('No response from Ollama model');
  }

  // Try to extract JSON from the response (handle potential markdown wrapping)
  let jsonContent = content;
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonContent = jsonMatch[1].trim();
  }
  
  // Try to find JSON object in the response
  const jsonObjectMatch = jsonContent.match(/\{[\s\S]*\}/);
  if (jsonObjectMatch) {
    jsonContent = jsonObjectMatch[0];
  }

  let analysisData;
  try {
    analysisData = JSON.parse(jsonContent);
  } catch (parseError) {
    console.error('Failed to parse JSON:', content);
    // Return a fallback response if parsing fails
    analysisData = {
      behaviorSummary: content.substring(0, 500),
      observedBehaviors: [],
      emotionalStates: [{ state: 'Unknown', confidence: 'Low', explanation: 'Could not parse structured response' }],
      primaryMood: 'Unable to determine',
      stressIndicators: { status: 'Unclear', details: [] },
      healthIndicators: [],
      overallConfidence: 'Low',
      confidenceScore: 0.3,
      notes: ['Response could not be parsed as structured JSON'],
      uncertainties: ['Analysis structure was not properly formatted'],
      recommendations: ['Please try uploading a clearer image'],
    };
  }
  
  return {
    ...analysisData,
    analysisTimestamp: new Date().toISOString(),
    framesAnalyzed: frames.length,
  };
}

export async function POST(request: NextRequest) {
  try {
    // Check Ollama connectivity
    try {
      const healthCheck = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { method: 'GET' });
      if (!healthCheck.ok) {
        throw new Error('Ollama not responding');
      }
    } catch (connError) {
      return NextResponse.json(
        { error: `Cannot connect to Ollama at ${OLLAMA_BASE_URL}. Make sure Ollama is running with: ollama serve` },
        { status: 500 }
      );
    }

    const formData = await request.formData();
    const video = formData.get('video') as File;

    if (!video) {
      return NextResponse.json(
        { error: 'No video file provided' },
        { status: 400 }
      );
    }

    // Validate file type
    const validTypes = ['video/mp4', 'video/quicktime', 'video/webm', 'video/avi', 'image/jpeg', 'image/png', 'image/gif'];
    if (!validTypes.some(type => video.type.includes(type.split('/')[1]))) {
      return NextResponse.json(
        { error: 'Invalid file type. Please upload a video (MP4, MOV, WebM) or image (JPG, PNG).' },
        { status: 400 }
      );
    }

    // Check file size (50MB limit)
    const maxSize = 50 * 1024 * 1024;
    if (video.size > maxSize) {
      return NextResponse.json(
        { error: 'File too large. Maximum size is 50MB.' },
        { status: 400 }
      );
    }

    // Convert to buffer
    const bytes = await video.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // For images, analyze directly; for videos, extract frames
    let frames: string[];
    let mimeType = video.type;

    if (video.type.startsWith('image/')) {
      frames = [buffer.toString('base64')];
    } else {
      // For videos, we'll send the first frame or use a snapshot
      // In production, you'd extract multiple frames using ffmpeg
      frames = await extractFramesFromVideo(buffer);
      mimeType = 'image/jpeg'; // Assume extracted frames are JPEG
    }

    // Analyze with Vision API
    const result = await analyzeWithVision(frames, mimeType);

    return NextResponse.json(result);
  } catch (error) {
    console.error('Analysis error:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('ECONNREFUSED') || error.message.includes('fetch failed')) {
        return NextResponse.json(
          { error: `Cannot connect to Ollama. Make sure Ollama is running: ollama serve` },
          { status: 500 }
        );
      }
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }
    
    return NextResponse.json(
      { error: 'An unexpected error occurred during analysis' },
      { status: 500 }
    );
  }
}

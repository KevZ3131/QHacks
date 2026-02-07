export interface BehaviorObservation {
  category: string;
  observation: string;
  significance: string;
}

export interface EmotionalState {
  state: string;
  confidence: 'Low' | 'Medium' | 'High';
  explanation: string;
}

export interface HealthIndicator {
  indicator: string;
  status: 'Present' | 'Not Present' | 'Unclear';
  details: string;
  severity?: 'Low' | 'Medium' | 'High';
}

export interface AnalysisResult {
  // Summary section
  behaviorSummary: string;
  
  // Detailed observations
  observedBehaviors: BehaviorObservation[];
  
  // Emotional analysis
  emotionalStates: EmotionalState[];
  primaryMood: string;
  
  // Stress indicators
  stressIndicators: {
    status: 'Present' | 'Not Present' | 'Unclear';
    details: string[];
  };
  
  // Health flags
  healthIndicators: HealthIndicator[];
  
  // Overall assessment
  overallConfidence: 'Low' | 'Medium' | 'High';
  confidenceScore: number; // 0-1
  
  // Additional notes
  notes: string[];
  uncertainties: string[];
  
  // Recommendations
  recommendations: string[];
  
  // Metadata
  analysisTimestamp: string;
  framesAnalyzed: number;
}

export interface AnalysisRequest {
  videoFrames: string[]; // Base64 encoded frames
}

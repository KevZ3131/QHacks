'use client';

import { AnalysisResult } from '@/types/analysis';
import { 
  Eye, 
  Heart, 
  Activity, 
  AlertTriangle, 
  CheckCircle, 
  HelpCircle,
  TrendingUp,
  MessageSquare,
  Lightbulb,
  Clock
} from 'lucide-react';

interface AnalysisResultsProps {
  result: AnalysisResult | null;
  isLoading: boolean;
}

function ConfidenceBadge({ level }: { level: 'Low' | 'Medium' | 'High' }) {
  const styles = {
    Low: 'confidence-low',
    Medium: 'confidence-medium',
    High: 'confidence-high',
  };

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${styles[level]}`}>
      {level}
    </span>
  );
}

function StatusIcon({ status }: { status: 'Present' | 'Not Present' | 'Unclear' }) {
  switch (status) {
    case 'Present':
      return <AlertTriangle className="w-5 h-5 text-amber-500" />;
    case 'Not Present':
      return <CheckCircle className="w-5 h-5 text-green-500" />;
    case 'Unclear':
      return <HelpCircle className="w-5 h-5 text-gray-400" />;
  }
}

function LoadingSkeleton() {
  return (
    <div className="bg-white rounded-xl shadow-lg p-6 animate-pulse">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 bg-gray-200 rounded-full" />
        <div className="h-6 bg-gray-200 rounded w-48" />
      </div>
      <div className="space-y-4">
        <div className="h-4 bg-gray-200 rounded w-full" />
        <div className="h-4 bg-gray-200 rounded w-3/4" />
        <div className="h-4 bg-gray-200 rounded w-5/6" />
      </div>
      <div className="grid grid-cols-2 gap-4 mt-6">
        <div className="h-24 bg-gray-200 rounded-lg" />
        <div className="h-24 bg-gray-200 rounded-lg" />
        <div className="h-24 bg-gray-200 rounded-lg" />
        <div className="h-24 bg-gray-200 rounded-lg" />
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="bg-white rounded-xl shadow-lg p-8 text-center">
      <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
        <Eye className="w-8 h-8 text-gray-400" />
      </div>
      <h3 className="text-lg font-semibold text-gray-900 mb-2">
        No Analysis Yet
      </h3>
      <p className="text-gray-600">
        Upload a video of your dog to get started with the behavioral analysis.
      </p>
    </div>
  );
}

export default function AnalysisResults({ result, isLoading }: AnalysisResultsProps) {
  if (isLoading) {
    return <LoadingSkeleton />;
  }

  if (!result) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-6">
      {/* Summary Card */}
      <div className="analysis-card">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary-100 rounded-full flex items-center justify-center">
              <Eye className="w-5 h-5 text-primary-600" />
            </div>
            <h2 className="text-xl font-bold text-gray-900">Analysis Results</h2>
          </div>
          <ConfidenceBadge level={result.overallConfidence} />
        </div>
        
        <p className="text-gray-700 leading-relaxed">{result.behaviorSummary}</p>
        
        <div className="flex items-center gap-4 mt-4 text-sm text-gray-500">
          <span className="flex items-center gap-1">
            <Clock className="w-4 h-4" />
            {new Date(result.analysisTimestamp).toLocaleTimeString()}
          </span>
          <span className="flex items-center gap-1">
            <TrendingUp className="w-4 h-4" />
            Confidence: {Math.round(result.confidenceScore * 100)}%
          </span>
        </div>
      </div>

      {/* Primary Mood */}
      <div className="analysis-card bg-gradient-to-r from-primary-50 to-orange-50">
        <div className="flex items-center gap-3 mb-3">
          <Heart className="w-6 h-6 text-primary-600" />
          <h3 className="text-lg font-semibold text-gray-900">Primary Mood</h3>
        </div>
        <p className="text-2xl font-bold text-primary-700">{result.primaryMood}</p>
      </div>

      {/* Emotional States */}
      {result.emotionalStates && result.emotionalStates.length > 0 && (
        <div className="analysis-card">
          <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Heart className="w-5 h-5 text-red-500" />
            Emotional State Analysis
          </h3>
          <div className="space-y-3">
            {result.emotionalStates.map((state, index) => (
              <div key={index} className="bg-gray-50 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium text-gray-900">{state.state}</span>
                  <ConfidenceBadge level={state.confidence} />
                </div>
                <p className="text-sm text-gray-600">{state.explanation}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Observed Behaviors */}
      {result.observedBehaviors && result.observedBehaviors.length > 0 && (
        <div className="analysis-card">
          <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Activity className="w-5 h-5 text-blue-500" />
            Observed Behaviors
          </h3>
          <div className="space-y-3">
            {result.observedBehaviors.map((behavior, index) => (
              <div key={index} className="border-l-4 border-blue-400 pl-4 py-2">
                <span className="inline-block bg-blue-100 text-blue-800 text-xs px-2 py-1 rounded mb-2">
                  {behavior.category}
                </span>
                <p className="text-gray-900 font-medium">{behavior.observation}</p>
                <p className="text-sm text-gray-600 mt-1">{behavior.significance}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stress Indicators */}
      <div className="analysis-card">
        <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-amber-500" />
          Stress Indicators
        </h3>
        <div className="flex items-center gap-3 mb-3">
          <StatusIcon status={result.stressIndicators?.status || 'Unclear'} />
          <span className="font-medium text-gray-900">
            {result.stressIndicators?.status || 'Unclear'}
          </span>
        </div>
        {result.stressIndicators?.details && result.stressIndicators.details.length > 0 && (
          <ul className="list-disc list-inside text-gray-600 space-y-1">
            {result.stressIndicators.details.map((detail, index) => (
              <li key={index}>{detail}</li>
            ))}
          </ul>
        )}
      </div>

      {/* Health Indicators */}
      {result.healthIndicators && result.healthIndicators.length > 0 && (
        <div className="analysis-card">
          <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Activity className="w-5 h-5 text-green-500" />
            Health Indicators
          </h3>
          <div className="space-y-3">
            {result.healthIndicators.map((indicator, index) => (
              <div key={index} className="flex items-start gap-3 bg-gray-50 rounded-lg p-4">
                <StatusIcon status={indicator.status} />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-gray-900">{indicator.indicator}</span>
                    {indicator.severity && (
                      <span className={`text-xs px-2 py-1 rounded ${
                        indicator.severity === 'High' ? 'bg-red-100 text-red-700' :
                        indicator.severity === 'Medium' ? 'bg-amber-100 text-amber-700' :
                        'bg-green-100 text-green-700'
                      }`}>
                        {indicator.severity} Severity
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-600 mt-1">{indicator.details}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recommendations */}
      {result.recommendations && result.recommendations.length > 0 && (
        <div className="analysis-card bg-gradient-to-r from-green-50 to-emerald-50">
          <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Lightbulb className="w-5 h-5 text-green-600" />
            Recommendations
          </h3>
          <ul className="space-y-2">
            {result.recommendations.map((rec, index) => (
              <li key={index} className="flex items-start gap-2">
                <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
                <span className="text-gray-700">{rec}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Notes & Uncertainties */}
      {((result.notes && result.notes.length > 0) || (result.uncertainties && result.uncertainties.length > 0)) && (
        <div className="analysis-card">
          <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <MessageSquare className="w-5 h-5 text-gray-500" />
            Additional Notes
          </h3>
          
          {result.notes && result.notes.length > 0 && (
            <div className="mb-4">
              <h4 className="text-sm font-medium text-gray-700 mb-2">Observations:</h4>
              <ul className="list-disc list-inside text-gray-600 space-y-1">
                {result.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            </div>
          )}
          
          {result.uncertainties && result.uncertainties.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-2">Uncertainties:</h4>
              <ul className="list-disc list-inside text-gray-500 space-y-1">
                {result.uncertainties.map((uncertainty, index) => (
                  <li key={index}>{uncertainty}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

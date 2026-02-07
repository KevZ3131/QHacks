'use client';

import { useState } from 'react';
import VideoUpload from '@/components/VideoUpload';
import AnalysisResults from '@/components/AnalysisResults';
import Header from '@/components/Header';
import { AnalysisResult } from '@/types/analysis';
import { Dog, Heart, Brain, Activity } from 'lucide-react';

export default function Home() {
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoPreview, setVideoPreview] = useState<string | null>(null);

  const handleVideoUpload = async (file: File) => {
    setIsAnalyzing(true);
    setError(null);
    setAnalysisResult(null);

    // Create video preview
    const previewUrl = URL.createObjectURL(file);
    setVideoPreview(previewUrl);

    try {
      const formData = new FormData();
      formData.append('video', file);

      const response = await fetch('/api/analyze', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Analysis failed');
      }

      const result = await response.json();
      setAnalysisResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred during analysis');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleReset = () => {
    setAnalysisResult(null);
    setVideoPreview(null);
    setError(null);
  };

  return (
    <main className="min-h-screen">
      <Header />
      
      {/* Hero Section */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="text-center mb-12">
          <div className="flex justify-center items-center gap-3 mb-4">
            <Dog className="w-12 h-12 text-primary-600" />
            <h1 className="text-4xl md:text-5xl font-bold text-gray-900">
              Dog Behavior Analyzer
            </h1>
          </div>
          <p className="text-xl text-gray-600 max-w-3xl mx-auto">
            Upload a video of your dog and get AI-powered insights into their behavior, 
            emotional state, and potential health indicators.
          </p>
        </div>

        {/* Features Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
          <div className="bg-white rounded-xl p-6 shadow-md text-center">
            <Brain className="w-10 h-10 text-primary-500 mx-auto mb-3" />
            <h3 className="font-semibold text-gray-900 mb-2">Behavior Analysis</h3>
            <p className="text-gray-600 text-sm">
              Detects body posture, tail position, ear movement, and facial expressions
            </p>
          </div>
          <div className="bg-white rounded-xl p-6 shadow-md text-center">
            <Heart className="w-10 h-10 text-red-500 mx-auto mb-3" />
            <h3 className="font-semibold text-gray-900 mb-2">Mood Detection</h3>
            <p className="text-gray-600 text-sm">
              Identifies emotional states like happy, anxious, relaxed, or stressed
            </p>
          </div>
          <div className="bg-white rounded-xl p-6 shadow-md text-center">
            <Activity className="w-10 h-10 text-green-500 mx-auto mb-3" />
            <h3 className="font-semibold text-gray-900 mb-2">Health Indicators</h3>
            <p className="text-gray-600 text-sm">
              Flags potential discomfort signs like limping, stiffness, or unusual behavior
            </p>
          </div>
        </div>

        {/* Main Content Area */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Video Upload Section */}
          <div className="space-y-6">
            <VideoUpload 
              onUpload={handleVideoUpload} 
              isAnalyzing={isAnalyzing}
              videoPreview={videoPreview}
              onReset={handleReset}
            />
            
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                <p className="text-red-700 font-medium">Error</p>
                <p className="text-red-600 text-sm">{error}</p>
              </div>
            )}
          </div>

          {/* Results Section */}
          <div>
            <AnalysisResults 
              result={analysisResult} 
              isLoading={isAnalyzing}
            />
          </div>
        </div>

        {/* Disclaimer */}
        <div className="mt-12 bg-amber-50 border border-amber-200 rounded-xl p-6">
          <h4 className="font-semibold text-amber-800 mb-2">⚠️ Important Disclaimer</h4>
          <p className="text-amber-700 text-sm">
            This tool provides behavioral observations and suggestions only. It is not a substitute 
            for professional veterinary advice. If you have concerns about your dog's health or 
            behavior, please consult a licensed veterinarian or certified animal behaviorist.
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-gray-50 border-t mt-12 py-8">
        <div className="max-w-7xl mx-auto px-4 text-center text-gray-600">
          <p>Built with ❤️ for QHacks 2026</p>
        </div>
      </footer>
    </main>
  );
}

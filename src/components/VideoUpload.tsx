'use client';

import { useCallback, useState } from 'react';
import { Upload, Video, X, Loader2 } from 'lucide-react';

interface VideoUploadProps {
  onUpload: (file: File) => void;
  isAnalyzing: boolean;
  videoPreview: string | null;
  onReset: () => void;
}

export default function VideoUpload({ 
  onUpload, 
  isAnalyzing, 
  videoPreview, 
  onReset 
}: VideoUploadProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('video/')) {
      onUpload(file);
    }
  }, [onUpload]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onUpload(file);
    }
  }, [onUpload]);

  if (videoPreview) {
    return (
      <div className="bg-white rounded-xl shadow-lg overflow-hidden">
        <div className="relative">
          <video 
            src={videoPreview} 
            controls 
            className="w-full aspect-video object-cover"
          />
          {!isAnalyzing && (
            <button
              onClick={onReset}
              className="absolute top-4 right-4 bg-white/90 hover:bg-white p-2 rounded-full shadow-lg transition-all"
            >
              <X className="w-5 h-5 text-gray-700" />
            </button>
          )}
          {isAnalyzing && (
            <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
              <div className="text-center text-white">
                <Loader2 className="w-12 h-12 animate-spin mx-auto mb-3" />
                <p className="font-medium">Analyzing behavior...</p>
                <p className="text-sm text-white/80">This may take a moment</p>
              </div>
            </div>
          )}
        </div>
        <div className="p-4 bg-gray-50 border-t">
          <p className="text-sm text-gray-600">
            {isAnalyzing ? 'Processing video frames...' : 'Video uploaded successfully'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-lg p-8">
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`dropzone ${isDragging ? 'active' : ''}`}
      >
        <input
          type="file"
          accept="video/*"
          onChange={handleFileSelect}
          className="hidden"
          id="video-upload"
        />
        <label htmlFor="video-upload" className="cursor-pointer block">
          <div className="flex flex-col items-center">
            <div className="w-16 h-16 bg-primary-100 rounded-full flex items-center justify-center mb-4">
              <Upload className="w-8 h-8 text-primary-600" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              Upload a video of your dog
            </h3>
            <p className="text-gray-600 mb-4">
              Drag and drop or click to select
            </p>
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Video className="w-4 h-4" />
              <span>MP4, MOV, AVI, WebM (max 50MB)</span>
            </div>
          </div>
        </label>
      </div>

      {/* Tips Section */}
      <div className="mt-6 space-y-3">
        <h4 className="font-medium text-gray-900">Tips for best results:</h4>
        <ul className="text-sm text-gray-600 space-y-2">
          <li className="flex items-start gap-2">
            <span className="text-primary-500">•</span>
            Ensure good lighting so the dog is clearly visible
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-500">•</span>
            Include the dog's full body in frame when possible
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-500">•</span>
            5-30 seconds of video works best for analysis
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-500">•</span>
            Capture natural behavior rather than commands
          </li>
        </ul>
      </div>
    </div>
  );
}

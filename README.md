# Dog Behavior Analyzer

🐕 AI-powered dog behavior and mood analysis from video/images.

Built for **QHacks 2026** 🏆

## Features

- 📹 **Video/Image Upload** - Drag and drop or click to upload
- 🧠 **AI Behavior Analysis** - Powered by Ollama with LLaVA vision model (runs locally!)
- 😊 **Mood Detection** - Identifies emotional states (happy, anxious, relaxed, stressed, etc.)
- 🏥 **Health Indicators** - Flags potential discomfort signs
- 📊 **Confidence Scoring** - Transparency about analysis certainty
- 🎨 **Beautiful UI** - Modern, responsive design with Tailwind CSS
- 🔒 **Privacy-First** - All processing happens locally on your machine

## What It Analyzes

| Category | Signals |
|----------|---------|
| Body Posture | Tail position, ear position, stance, body tension |
| Facial Expression | Eye openness, blinking, gaze direction, mouth position |
| Movement | Gait fluidity, stiffness, restlessness, lethargy |
| Stress Signs | Lip licking, yawning, panting, whale eye, tucked tail |
| Health Flags | Limping, excessive panting, avoidance, stiffness |

## Tech Stack

- **Frontend**: Next.js 14, React 18, TypeScript
- **Styling**: Tailwind CSS
- **AI**: Ollama + LLaVA (local vision model)
- **Icons**: Lucide React

## Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn
- [Ollama](https://ollama.ai/) installed and running

### Installation

1. **Install Ollama** (if not already installed):
   - Download from [ollama.ai](https://ollama.ai/)
   - Or on macOS: `brew install ollama`

2. **Pull the LLaVA vision model**:
   ```bash
   ollama pull llava
   ```

3. **Start Ollama server** (if not running):
   ```bash
   ollama serve
   ```

4. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/dog-behavior-analyzer.git
   cd dog-behavior-analyzer
   ```

5. Install dependencies:
   ```bash
   npm install
   ```

6. (Optional) Configure environment variables:
   ```bash
   cp .env.local.example .env.local
   ```
   
   Edit `.env.local` to customize:
   ```
   OLLAMA_BASE_URL=http://localhost:11434
   OLLAMA_MODEL=llava
   ```

7. Run the development server:
   ```bash
   npm run dev
   ```

8. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Available Vision Models

You can use different Ollama vision models by changing `OLLAMA_MODEL`:

| Model | Size | Description |
|-------|------|-------------|
| `llava` | ~4.7GB | Default, good balance of speed/quality |
| `llava:13b` | ~8GB | Larger, more accurate |
| `llava-llama3` | ~5GB | Based on Llama 3, newer |
| `bakllava` | ~4.7GB | Alternative LLaVA implementation |

Pull your preferred model:
```bash
ollama pull llava-llama3
```

## Usage

1. Upload a video or image of your dog
2. Wait for the AI to analyze the content
3. Review the detailed behavioral assessment including:
   - Behavior summary
   - Primary mood detection
   - Emotional state analysis
   - Stress indicators
   - Health flags
   - Recommendations

## Example Output

```json
{
  "behaviorSummary": "Dog is lying down with relaxed body posture...",
  "primaryMood": "Calm and Relaxed",
  "emotionalStates": [
    {
      "state": "Relaxed",
      "confidence": "High",
      "explanation": "Loose body posture, slow breathing..."
    }
  ],
  "stressIndicators": {
    "status": "Not Present",
    "details": []
  },
  "healthIndicators": [
    {
      "indicator": "General mobility",
      "status": "Not Present",
      "details": "No signs of discomfort observed"
    }
  ],
  "overallConfidence": "High",
  "confidenceScore": 0.85
}
```

## Tips for Best Results

- 📸 Ensure good lighting
- 🐕 Include the dog's full body when possible
- ⏱️ 5-30 seconds of video works best
- 🎯 Capture natural behavior rather than posed shots

## Disclaimer

⚠️ This tool provides behavioral observations and suggestions only. It is **not** a substitute for professional veterinary advice. If you have concerns about your dog's health or behavior, please consult a licensed veterinarian or certified animal behaviorist.

## License

MIT License - feel free to use this project for your own purposes!

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

Made with ❤️ and 🐕 at QHacks 2026

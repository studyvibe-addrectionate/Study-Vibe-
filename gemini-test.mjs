import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error("Missing GEMINI_API_KEY. Check your .env file.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

try {
  const result = await ai.models.generateContent({
    model: "gemini-3.8-flash",
    contents: "Solve 2x + 4 = 10. Show the steps briefly."
  });

  console.log("Gemini connection successful!");
  console.log(result.text);
} catch (error) {
  console.error("Gemini test failed:", error.message);
}
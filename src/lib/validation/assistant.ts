import { z } from "zod";

export const askAssistantSchema = z.object({
  question: z.string().trim().min(1, "Ask a question.").max(500, "Keep questions under 500 characters."),
});

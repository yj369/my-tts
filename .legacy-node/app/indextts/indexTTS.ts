import { Client } from "@gradio/client";

export type IndexTTSClientConfig = {
  baseUrl?: string;
};

export type IndexTTSFile = Blob | File | IndexTTSFileData | string;

export type IndexTTSFileData = {
  path?: string;
  url?: string;
  size?: number;
  orig_name?: string;
  mime_type?: string;
  is_stream?: boolean;
  meta?: Record<string, unknown>;
};

export type IndexTTSGenSingleInput = {
  emo_control_method?: string;
  prompt: IndexTTSFile;
  text: string;
  emo_ref_path: IndexTTSFile;
  emo_weight?: number;
  vec1?: number;
  vec2?: number;
  vec3?: number;
  vec4?: number;
  vec5?: number;
  vec6?: number;
  vec7?: number;
  vec8?: number;
  emo_text?: string;
  emo_random?: boolean;
  max_text_tokens_per_segment?: number;
  param_16?: boolean;
  param_17?: number;
  param_18?: number;
  param_19?: number;
  param_20?: number;
  param_21?: number;
  param_22?: number;
  param_23?: number;
};

export type IndexTTSExampleClickOutput = [
  unknown,
  string,
  string,
  unknown,
  number,
  string,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export const createIndexTTSClient = (config: IndexTTSClientConfig = {}) => {
  const baseUrl =
    config.baseUrl ?? process.env.INDEX_TTS_BASE_URL ?? "http://localhost:7860/";
  let clientPromise: Promise<Client> | null = null;

  const connect = async () => {
    if (!clientPromise) {
      clientPromise = Client.connect(baseUrl);
    }
    return clientPromise;
  };

  const predict = async <T = unknown>(
    apiName: string,
    payload: Record<string, unknown> = {}
  ) => {
    const client = await connect();
    const result = await client.predict(apiName, payload);
    return result.data as T;
  };

  return {
    predict,
    onExampleClick: (example: unknown) =>
      predict<IndexTTSExampleClickOutput>("/on_example_click", { example }),
    onMethodChange: (emo_control_method: string) =>
      predict("/on_method_change", { emo_control_method }),
    onExperimentalChange: (
      is_experimental: boolean,
      current_mode_index: string
    ) =>
      predict("/on_experimental_change", {
        is_experimental,
        current_mode_index,
      }),
    onGlossaryCheckboxChange: (is_enabled: boolean) =>
      predict("/on_glossary_checkbox_change", { is_enabled }),
    onInputTextChange: (text: string, max_text_tokens_per_segment?: number) =>
      predict("/on_input_text_change", {
        text,
        max_text_tokens_per_segment,
      }),
    onInputTextChange1: (text: string, max_text_tokens_per_segment?: number) =>
      predict("/on_input_text_change_1", {
        text,
        max_text_tokens_per_segment,
      }),
    updatePromptAudio: () => predict("/update_prompt_audio"),
    onAddGlossaryTerm: (term: string, reading_zh: string, reading_en: string) =>
      predict("/on_add_glossary_term", { term, reading_zh, reading_en }),
    onDemoLoad: () => predict("/on_demo_load"),
    genSingle: (input: IndexTTSGenSingleInput) => predict("/gen_single", input),
    withBaseUrl: (url: string) => createIndexTTSClient({ baseUrl: url }),
  };
};

export const IndexTTS = createIndexTTSClient();

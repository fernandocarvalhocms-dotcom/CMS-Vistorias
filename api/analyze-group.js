import OpenAI from "openai";

const MODEL = process.env.OPENAI_VISION_MODEL || "gpt-5.6-luna";

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    group_summary: { type: "string" },
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          index: { type: "integer" },
          element: { type: "string" },
          finding: { type: "string" },
          condition: {
            type: "string",
            enum: ["Bom", "Regular", "Ruim", "Não verificado"]
          },
          action_class: {
            type: "string",
            enum: ["I", "M", "C", "E"]
          },
          caption: { type: "string" },
          recommendation: { type: "string" },
          confidence: { type: "number" },
          review_required: { type: "boolean" }
        },
        required: [
          "index","element","finding","condition","action_class",
          "caption","recommendation","confidence","review_required"
        ]
      }
    }
  },
  required: ["group_summary","results"]
};

const systemPrompt = `
Você atua como engenheiro civil assistente de um Relatório Técnico de Inspeção Visual
de imóvel industrial para registro das condições aparentes antes da locação.

Analise exclusivamente o que é visualmente observável. Não conclua sobre estabilidade,
vícios ocultos, causa definitiva, conformidade normativa ou desempenho não demonstrado pelas imagens.

As fotografias recebidas pertencem ao mesmo local/pasta e devem ser interpretadas em conjunto.
Use os diferentes enquadramentos para entender contexto, extensão e repetição, mas produza
um resultado individual para cada foto.

CLASSIFICAÇÃO DA CONDIÇÃO:
Bom = sem anomalia visual relevante no registro.
Regular = desgaste, deficiência, anomalia localizada ou condição que demande manutenção/correção,
sem evidência visual de condição crítica.
Ruim = deterioração relevante, perda funcional aparente ou necessidade de intervenção prioritária.
Não verificado = a foto não permite avaliação confiável.

CLASSE:
I = Informativo.
M = Manutenção.
C = Correção/reparo.
E = Avaliação específica.

REGRAS:
- Prefira redações como "observa-se", "aparenta" e "há indícios visuais" quando houver incerteza.
- Não declare "abaulamento", "recalque", "falha estrutural", "infiltração ativa" ou causa específica
  como certeza se a foto apenas sugerir a situação.
- Em pavimento com água acumulada, registre "empoçamento/acúmulo de água" e, se visualmente plausível,
  "aparente irregularidade superficial e/ou deficiência de caimento/drenagem".
- Água acumulada sobre pavimento NÃO deve ser classificada automaticamente como Bom.
- Trincas, fissuras, corrosão, quebras, peças ausentes, danos por impacto, umidade, deformações aparentes,
  obstruções de drenagem e deterioração de juntas devem ser explicitamente descritas quando visíveis.
- Se mais de uma foto confirmar a mesma manifestação, aumente a confiança, mas adapte a legenda
  ao enquadramento individual.
- Se uma foto não mostrar anomalia relevante, Bom / I é adequado.
- Marque review_required=true quando houver dúvida, baixa confiança, manifestação potencialmente relevante
  ou quando a decisão depender de confirmação presencial.
- caption deve ser técnica, objetiva e pronta para entrar no laudo.
- recommendation deve ser prudente e compatível com inspeção visual.
`;

function extractOutputText(response) {
  if (response.output_text) return response.output_text;
  for (const item of response.output || []) {
    if (item.type !== "message") continue;
    for (const part of item.content || []) {
      if (part.type === "output_text" && part.text) return part.text;
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST." });
  }

  const configuredKey = process.env.OPENAI_API_KEY;
  const suppliedKey = req.headers["x-openai-key"];
  const apiKey = configuredKey || suppliedKey;
  if (!apiKey) {
    return res.status(400).json({
      error: "Configure OPENAI_API_KEY no Vercel ou informe uma chave no painel do site."
    });
  }

  const accessToken = process.env.CMS_ACCESS_TOKEN;
  if (accessToken && req.headers["x-cms-access-token"] !== accessToken) {
    return res.status(401).json({ error: "Código de acesso inválido." });
  }

  const { images, metadata } = req.body || {};
  if (!Array.isArray(images) || images.length < 1 || images.length > 4) {
    return res.status(400).json({ error: "Envie de 1 a 4 imagens por grupo." });
  }
  if (JSON.stringify(req.body || {}).length > 5_500_000) {
    return res.status(413).json({ error: "Grupo de imagens muito grande. Reduza as fotos ou analise menos por vez." });
  }

  const meta = Array.isArray(metadata) ? metadata : [];
  const userText = `
As ${images.length} fotografias abaixo pertencem ao mesmo grupo de localização ou sequência próxima.

Metadados:
${JSON.stringify(meta, null, 2)}

Retorne exatamente um resultado por imagem, preservando index 0..${images.length-1}.
Use as demais fotos do grupo para contextualizar a análise de cada imagem.
`;

  const content = [{ type: "input_text", text: userText }];
  images.forEach((imageUrl, i) => {
    content.push({ type: "input_text", text: `IMAGEM ${i+1} / index ${i}` });
    content.push({ type: "input_image", image_url: imageUrl, detail: "high" });
  });

  try {
    const openai = new OpenAI({ apiKey });
    const response = await openai.responses.create({
      model: MODEL,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "inspection_group",
          strict: true,
          schema
        }
      }
    });

    const text = extractOutputText(response);
    if (!text) throw new Error("A API não retornou texto estruturado.");
    const parsed = JSON.parse(text);

    if (!Array.isArray(parsed.results) || parsed.results.length !== images.length) {
      throw new Error("Quantidade de resultados diferente da quantidade de fotos.");
    }
    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({
      error: err?.message || "Falha na análise das imagens."
    });
  }
}

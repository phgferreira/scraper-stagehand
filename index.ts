import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

// ============================================================================
// 1. CONFIGURAÇÕES DE ENTRADA (Sites, Produto, Modelos de IA e Detalhes)
// ============================================================================

const listaEcommerces: string[] = [
    "https://www.mercadolivre.com.br",
    // "https://www.amazon.com.br",
    // Nota: Shopee frequentemente exige login bloqueando automações sem autenticação prévia
    // "https://www.magazineluiza.com.br",
    // "https://www.americanas.com.br",
    // Adicione outros domínios diferentes aqui
];

// Lista de modelos de IA em ordem de prioridade
const listaModelosIA: string[] = [
    "google/gemini-3.5-flash",
    "google/gemini-3.6-flash",
];

const descricaoProdutoBusca = "smartphone";

// Lista de detalhes que você deseja obter, acompanhados de exemplos reais
const detalhesDesejados = [
    { campo: "nome", descricao: "Nome completo do produto", exemplo: "Notebook Lenovo IdeaPad 1i Intel Core i5 8GB 512GB SSD" },
    { campo: "precoAVista", descricao: "Preço para pagamento à vista (PIX ou boleto)", exemplo: "R$ 2.799,00" },
    { campo: "precoTotalParcelado", descricao: "Valor total somando todas as parcelas no cartão", exemplo: "R$ 3.110,00" },
    { campo: "frete", descricao: "Valor do frete ou indicação de gratuidade", exemplo: "R$ 24,90 ou Frete Grátis" },
    { campo: "marca", descricao: "Marca", exemplo: "Motorola" },
    { campo: "modelo", descricao: "Modelo", exemplo: "XT2623-1 " },
    { campo: "processador", descricao: "Modelo e capacidade do processador", exemplo: "MediaTek Helio G81 Extreme octa-core de 2,0 GHz" },
    { campo: "memória", descricao: "Capacidade da memória RAM", exemplo: "4GB de RAM" },
    { campo: "armazenamentoInterno", descricao: "Capacidade de armazenamento interno", exemplo: "128GB" },
    { campo: "cameraFrontal", descricao: "Capacidade da câmera frontal", exemplo: "32MP" },
    { campo: "cameraTraseira", descricao: "Capacidade de câmera traseira", exemplo: "50MP + 5MP ultra-wide" },
    { campo: "bateria", descricao: "Capacidade da bateria", exemplo: "5200 mAh" },
    { campo: "tamanhoTela", descricao: "Tamanho da tela", exemplo: "6,7" },
    { campo: "temNfc", descricao: "Tem NFC", exemplo: "Sim" },
    { campo: "wifi", descricao: "Versão do Wi-fi", exemplo: "6" },
] as const;

// ============================================================================
// 2. TIPOS E SCHEMAS ZOD
// ============================================================================

const identificadoresDominioSchema = z.object({
    seletorNome: z.string().describe("Seletor CSS único e específico para o título/nome do produto na página de detalhes"),
    seletorPrecoAVista: z.string().describe("Seletor CSS para o preço à vista na página de detalhes"),
    seletorPrecoTotalParcelado: z.string().describe("Seletor CSS para o preço parcelado (ou valor da parcela + quantidade) na página de detalhes"),
    seletorPrecoFrete: z.string().describe("Seletor CSS para a área que exibe o valor do frete ou frete grátis na página de detalhes").optional(),
    seletorFrete: z.string().describe("Seletor CSS para a área que exibe o valor do frete ou frete grátis na página de detalhes"),
});

type IdentificadoresMapeados = z.infer<typeof identificadoresDominioSchema>;

interface DominioConfigurado {
    urlBase: string;
    dominio: string;
    identificadores: IdentificadoresMapeados;
}

const produtoExtraidoSchema = z.object({
    nome: z.string(),
    precoAVista: z.string(),
    precoTotalParcelado: z.string(),
    frete: z.string(),
});

interface ProdutoFinal extends z.infer<typeof produtoExtraidoSchema> {
    dominio: string;
    linkProduto: string;
}

// ============================================================================
// 3. FUNÇÕES AUXILIARES
// ============================================================================

function parsePrecoToNumber(precoStr: string): number {
    if (!precoStr) return 9999999;
    const upper = precoStr.toUpperCase();
    if (upper.includes("N/A") || upper.includes("INDISPONÍVEL")) return 9999999;
    if (upper.includes("GRÁTIS")) return 0;

    const match = precoStr.match(/(\d{1,3}(?:\.\d{3})*,\d{2})/);
    if (match) {
        const valor = parseFloat(match[1].replace(/\./g, "").replace(",", "."));
        return isNaN(valor) ? 9999999 : valor;
    }

    const limpo = precoStr.replace(/[^\d,]/g, "").replace(",", ".");
    const valor = parseFloat(limpo);
    return isNaN(valor) ? 9999999 : valor;
}

function formatarCampoCSV(valor: string | undefined): string {
    if (!valor) return '""';
    const textoLimpo = valor.replace(/"/g, '""').replace(/\s+/g, " ").trim();
    return `"${textoLimpo}"`;
}

function ehErroDeCota(err: any): boolean {
    const mensagem = (err?.message || String(err)).toLowerCase();
    return (
        mensagem.includes("quota") ||
        mensagem.includes("rate limit") ||
        mensagem.includes("exceeded") ||
        mensagem.includes("429") ||
        mensagem.includes("resource_exhausted")
    );
}

async function aguardarPaginaEstavel(page: any, tempoExtraMs = 2500) {
    try {
        await page.waitForLoadState("networkidle", { timeout: 10000 });
    } catch {
        // Ignora caso mantenha conexões abertas contínuas
    }
    await new Promise((r) => setTimeout(r, tempoExtraMs));
}

async function obterHtmlLimpoParaMapeamento(page: any): Promise<string> {
    return await page.evaluate(() => {
        const clone = document.body.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("script, style, svg, noscript, iframe, header, footer").forEach((el) => el.remove());
        return clone.innerHTML.replace(/\s+/g, " ").slice(0, 45000);
    });
}

async function extrairTextoPorSeletor(page: any, seletor: string): Promise<string> {
    if (!seletor || seletor.trim() === "") return "";
    try {
        return await page.evaluate((sel: string) => {
            const el = document.querySelector(sel);
            return el ? (el as HTMLElement).innerText.trim() : "";
        }, seletor);
    } catch {
        return "";
    }
}

// Helper para executar comandos do Stagehand com política de 1 tentativa para cota ou 3 para erros gerais
async function executarComRetryIA<T>(
    stagehand: any,
    modelNameAtual: string,
    operacao: () => Promise<T>
): Promise<T> {
    let tentativas = 0;
    const maxTentativasPorModelo = 3;

    while (tentativas < maxTentativasPorModelo) {
        try {
            return await operacao();
        } catch (err: any) {
            tentativas++;

            // Se for erro de cota excedida, aborta as 3 tentativas e propaga imediatamente
            if (ehErroDeCota(err)) {
                console.warn(`⚠️ [${modelNameAtual}] Limite de cota atingido imediatamente. Pulando reiterações.`);
                throw err;
            }

            console.warn(`⚠️ [${modelNameAtual}] Falha na tentativa ${tentativas}/${maxTentativasPorModelo}: ${err?.message || err}`);
            if (tentativas >= maxTentativasPorModelo) {
                throw err;
            }
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
    throw new Error("Erro desconhecido nas tentativas de IA.");
}

// ============================================================================
// 4. FLUXO PRINCIPAL
// ============================================================================

async function main() {
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) {
        throw new Error("A chave GOOGLE_GENERATIVE_AI_API_KEY não foi encontrada no arquivo .env.");
    }

    let browser = await localBrowser.launch({
        headless: false,
    });

    let stagehand: any = null;
    let modeloAtivoComSucesso = "";
    let ultimoErroIA: any = null;

    // Loop para tentar inicializar o Stagehand testando a lista de modelos em ordem de prioridade
    for (const modelName of listaModelosIA) {
        console.log(`🤖 Tentando inicializar IA com o modelo: ${modelName}...`);
        try {
            stagehand = await Stagehand.create({
                browser,
                model: {
                    modelName,
                    apiKey,
                },
            });
            modeloAtivoComSucesso = modelName;
            console.log(`✅ Sucesso ao inicializar com o modelo: ${modelName}\n`);
            break;
        } catch (err: any) {
            ultimoErroIA = err;
            console.warn(`❌ Falha ao inicializar com o modelo ${modelName}: ${err?.message || err}`);
            if (ehErroDeCota(err)) {
                console.log(`ℹ️ Cota excedida na inicialização, passando para o próximo modelo.`);
            }
        }
    }

    // Se esgotar todos os modelos da lista sem conseguir inicializar
    if (!stagehand) {
        console.error(`\n❌ ERRO FATAL: Todos os modelos de IA da lista falharam ao inicializar.`);
        console.error(`Ultimo motivo do erro: ${ultimoErroIA?.message || ultimoErroIA}`);
        console.log(`🔒 Fechando navegador e encerrando aplicação.`);
        await browser.close();
        process.exit(1);
    }

    const memoriaDominios: DominioConfigurado[] = [];
    const memoriaProdutos: ProdutoFinal[] = [];

    const especificacaoDetalhesTexto = detalhesDesejados
        .map((d) => `- ${d.campo}: ${d.descricao} (Exemplo: "${d.exemplo}")`)
        .join("\n");

    try {
        console.log("🚀 Navegador e Stagehand inicializados com sucesso!\n");

        // ====================================================================
        // FASE 1: LEVANTAMENTO DOS IDENTIFICADORES DE CADA DOMÍNIO
        // ====================================================================
        console.log("==================================================");
        console.log("FASE 1: Levantamento dos Identificadores por Domínio");
        console.log("==================================================");

        for (let i = 0; i < listaEcommerces.length; i++) {
            const urlBase = listaEcommerces[i];
            const dominio = new URL(urlBase).hostname;
            console.log(`\n[${i + 1}/${listaEcommerces.length}] 🔍 Acessando: ${urlBase}`);

            let sucessoDominioFase1 = false;
            let erroFase1Dominio: any = null;

            // Tenta varrer o domínio iterando pelos modelos disponíveis se necessário
            for (let mIndex = 0; mIndex < listaModelosIA.length; mIndex++) {
                const modelName = listaModelosIA[mIndex];
                try {
                    // Se o modelo atual mudou, reiniciamos o navegador e o stagehand para garantir canal RPC limpo
                    if (modelName !== modeloAtivoComSucesso) {
                        console.log(`🔄 Alternando modelo de IA para: ${modelName} (reiniciando navegador e sessão)`);
                        try { await stagehand.close(); } catch {}
                        try { await browser.close(); } catch {}

                        browser = await localBrowser.launch({ headless: false });
                        stagehand = await Stagehand.create({ browser, model: { modelName, apiKey } });
                        modeloAtivoComSucesso = modelName;
                    }

                    const [page] = await browser.context.pages();

                    await page.goto(urlBase, { waitUntil: "domcontentloaded", timeout: 40000 });
                    await aguardarPaginaEstavel(page, 2000);

                    console.log(`🤖 IA (${modelName}) identificando barra de busca e pesquisando "${descricaoProdutoBusca}"...`);
                    await executarComRetryIA(stagehand, modelName, async () => {
                        await stagehand.act(
                            `Localize a barra principal de pesquisa do site, digite "${descricaoProdutoBusca}" e pressione Enter ou clique no botão de buscar.`
                        );
                    });
                    await aguardarPaginaEstavel(page, 3500);

                    console.log("🤖 Acessando o 1º produto da lista de resultados...");
                    await executarComRetryIA(stagehand, modelName, async () => {
                        await stagehand.act("Clique no título ou link do primeiro produto exibido nos resultados da busca.");
                    });
                    await aguardarPaginaEstavel(page, 3500);

                    console.log("🧠 Mapeando identificadores CSS da página de detalhes do produto...");
                    const htmlLimpo = await obterHtmlLimpoParaMapeamento(page);

                    const mapeamentoResponse = await executarComRetryIA(stagehand, modelName, async () => {
                        return await stagehand.extract(
                            `Analise esta página de detalhes de produto e o trecho HTML abaixo para identificar os seletores CSS (classes, IDs ou atributos) que capturam exatamente os seguintes campos:
${especificacaoDetalhesTexto}

Regras:
- Retorne seletores CSS válidos compatíveis com document.querySelector().
- Priorize IDs, atributos data-* ou classes semânticas estáveis.
- Trecho HTML de referência: ${htmlLimpo}`,
                            identificadoresDominioSchema
                        );
                    });

                    const identificadores = mapeamentoResponse.data;

                    if (identificadores) {
                        memoriaDominios.push({
                            urlBase,
                            dominio,
                            identificadores,
                        });
                        console.log(`✅ Identificadores salvos em memória para ${dominio} usando ${modelName}:`, identificadores);
                        sucessoDominioFase1 = true;
                        break; // Sucesso, sai do loop de modelos para este domínio
                    }
                } catch (err: any) {
                    erroFase1Dominio = err;
                    console.warn(`⚠️ Falha no modelo ${modelName} para o domínio ${dominio}: ${err?.message || err}`);
                    
                    // Se for erro de cota, o loop avança imediatamente para o próximo modelo da lista
                    if (ehErroDeCota(err)) {
                        console.log(`ℹ️ Cota excedida detectada para ${modelName}. Pulando para o próximo modelo da prioridade...`);
                        continue;
                    }
                }
            }

            if (!sucessoDominioFase1) {
                console.error(`❌ Erro crítico: Todos os modelos falharam ao mapear o domínio ${urlBase}. Último erro: ${erroFase1Dominio?.message || erroFase1Dominio}`);
                console.log(`🔒 Fechando navegador e encerrando aplicação.`);
                await stagehand?.close();
                await browser.close();
                process.exit(1);
            }
        }

        console.log(`\n📋 Fase 1 concluída! ${memoriaDominios.length} domínio(s) mapeado(s) em memória.`);

        // ====================================================================
        // FASE 2: BUSCA E EXTRAÇÃO DETALHADA NOS DIFERENTES DOMÍNIOS
        // ====================================================================
        console.log("\n==================================================");
        console.log("FASE 2: Busca e Extração de Dados Detalhados");
        console.log("==================================================");

        const [pageFase2] = await browser.context.pages();

        for (let i = 0; i < memoriaDominios.length; i++) {
            const configDominio = memoriaDominios[i];
            console.log(`\n[${i + 1}/${memoriaDominios.length}] 🛒 Varrendo: ${configDominio.urlBase}`);

            try {
                await pageFase2.goto(configDominio.urlBase, { waitUntil: "domcontentloaded", timeout: 40000 });
                await aguardarPaginaEstavel(pageFase2, 2000);

                console.log(`🤖 Refazendo busca por "${descricaoProdutoBusca}"...`);
                await executarComRetryIA(stagehand, modeloAtivoComSucesso, async () => {
                    await stagehand.act(
                        `Localize a barra principal de pesquisa do site, digite "${descricaoProdutoBusca}" e pressione Enter ou clique no botão de buscar.`
                    );
                });
                await aguardarPaginaEstavel(pageFase2, 3500);

                console.log("🔗 Coletando links dos produtos exibidos na primeira página...");
                const linksResponse = await executarComRetryIA(stagehand, modeloAtivoComSucesso, async () => {
                    return await stagehand.extract(
                        `Extraia os links (URLs) de todos os produtos listados nesta primeira página de resultados da busca para "${descricaoProdutoBusca}". 
                        NÃO inclua links de paginação (próxima página), filtros, banners ou menus.`,
                        z.object({
                            linksProdutos: z.array(z.string()).describe("Lista de URLs das páginas de detalhes dos produtos"),
                        })
                    );
                });

                const linksUnicos = Array.from(
                    new Set(
                        (linksResponse.data?.linksProdutos || [])
                            .map((link) => {
                                try {
                                    return link.startsWith("http") ? link : new URL(link, configDominio.urlBase).href;
                                } catch {
                                    return "";
                                }
                            })
                            .filter((url) => url.includes(configDominio.dominio))
                    )
                );

                console.log(`📦 ${linksUnicos.length} produto(s) encontrado(s) na 1ª página de ${configDominio.dominio}.`);

                for (let j = 0; j < linksUnicos.length; j++) {
                    const linkProduto = linksUnicos[j];
                    console.log(`   ↳ [${j + 1}/${linksUnicos.length}] Acessando produto: ${linkProduto}`);

                    try {
                        await pageFase2.goto(linkProduto, { waitUntil: "domcontentloaded", timeout: 35000 });
                        await aguardarPaginaEstavel(pageFase2, 2500);

                        const { identificadores } = configDominio;

                        const nomeViaSeletor = await extrairTextoPorSeletor(pageFase2, identificadores.seletorNome);
                        const vistaViaSeletor = await extrairTextoPorSeletor(pageFase2, identificadores.seletorPrecoAVista);
                        const parceladoViaSeletor = await extrairTextoPorSeletor(pageFase2, identificadores.seletorPrecoTotalParcelado);
                        const freteViaSeletor = await extrairTextoPorSeletor(pageFase2, identificadores.seletorFrete);

                        let dadosProduto: z.infer<typeof produtoExtraidoSchema>;

                        if (nomeViaSeletor && vistaViaSeletor) {
                            dadosProduto = {
                                nome: nomeViaSeletor,
                                precoAVista: vistaViaSeletor,
                                precoTotalParcelado: parceladoViaSeletor || vistaViaSeletor,
                                frete: freteViaSeletor || "Consultar no carrinho",
                            };
                        } else {
                            const extracaoIA = await executarComRetryIA(stagehand, modeloAtivoComSucesso, async () => {
                                return await stagehand.extract(
                                    `Extraia os dados detalhados deste produto seguindo exatamente estes campos e exemplos:
${especificacaoDetalhesTexto}

Use como pista os seletores mapeados anteriormente para este domínio:
- Nome: ${identificadores.seletorNome}
- Preço à vista: ${identificadores.seletorPrecoAVista}
- Preço total parcelado: ${identificadores.seletorPrecoTotalParcelado}
- Frete: ${identificadores.seletorFrete}

Se não houver parcelamento com juros, repita o valor à vista no preço total parcelado.`,
                                    produtoExtraidoSchema
                                );
                            });

                            dadosProduto = extracaoIA.data || {
                                nome: nomeViaSeletor || "Nome não encontrado",
                                precoAVista: vistaViaSeletor || "N/A",
                                precoTotalParcelado: parceladoViaSeletor || "N/A",
                                frete: freteViaSeletor || "N/A",
                            };
                        }

                        memoriaProdutos.push({
                            ...dadosProduto,
                            dominio: configDominio.dominio,
                            linkProduto,
                        });

                        console.log(`      ✔ Extraído: ${dadosProduto.nome.slice(0, 45)}... | À vista: ${dadosProduto.precoAVista}`);
                    } catch (prodErr: any) {
                        console.error(`      ⚠️ Falha ao extrair produto (${linkProduto}): ${prodErr?.message || prodErr}`);
                    }
                }
            } catch (domErr: any) {
                console.error(`❌ Erro ao varrer ${configDominio.urlBase}: ${domErr?.message || domErr}`);
            }
        }

        // ====================================================================
        // FASE 3: ORDENAÇÃO E EXPORTAÇÃO PARA resultado.csv
        // ====================================================================
        console.log("\n==================================================");
        console.log("📊 Ordenando produtos do mais barato para o mais caro...");

        memoriaProdutos.sort((a, b) => {
            return parsePrecoToNumber(a.precoAVista) - parsePrecoToNumber(b.precoAVista);
        });

        const cabecalho = [
            "Domínio",
            "Nome do Produto",
            "Preço à Vista",
            "Preço Total Parcelado",
            "Frete",
            "Link do Produto",
        ].join(";");

        const linhas = memoriaProdutos.map((item) =>
            [
                formatarCampoCSV(item.dominio),
                formatarCampoCSV(item.nome),
                formatarCampoCSV(item.precoAVista),
                formatarCampoCSV(item.precoTotalParcelado),
                formatarCampoCSV(item.frete),
                formatarCampoCSV(item.linkProduto),
            ].join(";")
        );

        const conteudoCSV = "\uFEFF" + [cabecalho, ...linhas].join("\n");
        const caminhoArquivo = path.join(process.cwd(), "resultado.csv");

        fs.writeFileSync(caminhoArquivo, conteudoCSV, "utf-8");
        console.log(`🎉 Concluído! ${memoriaProdutos.length} produto(s) salvo(s) em: ${caminhoArquivo}`);
    } catch (error: any) {
        console.error("❌ Erro fatal na execução:", error?.message || error);
    } finally {
        await stagehand?.close();
        await browser?.close();
    }
}

main();

// Configuração de Armazenamento na Nuvem (KVDB.io)
// Usamos um bucket com chave específica para o Festival do Douglas
const BUCKET_ID = "sabores";
const KVDB_URL = `https://kvdb.io/HupTywL6Nr1yeDcDXgTyme/${BUCKET_ID}`;

// Estado Geral da Aplicação
let configuracoes = {};
let carrinho = {}; // Armazena id_item -> quantidade

// Estado do cálculo da taxa de entrega
let taxaEntregaCalculada = 0.0;
let statusTaxa = "pendente"; // pendente, calculando, sucesso, erro
let debounceTimer;
let pixCopiaColaGerado = "";

// Elementos do DOM
const fatiasContainer = document.getElementById("fatias-container");
const complementosContainer = document.getElementById("complementos-container");
const bottomBar = document.getElementById("bottom-bar");
const cartCount = document.getElementById("cart-count");
const cartTotal = document.getElementById("cart-total");
const comboDiscount = document.getElementById("combo-discount");
const checkoutForm = document.getElementById("checkout-form");
const btnSubmitOrder = document.getElementById("btn-submit-order");
const addressFields = document.getElementById("address-fields");
const deliveryRadios = document.getElementsByName("delivery_method");

// Inicialização
document.addEventListener("DOMContentLoaded", async () => {
    await carregarDados();
    configurarEventos();
});

// Busca os dados (da nuvem com fallback para arquivo local)
async function carregarDados() {
    try {
        // 1. Tenta carregar da Nuvem
        const response = await fetch(KVDB_URL);
        if (response.ok) {
            configuracoes = await response.json();
            console.log("Configurações carregadas da nuvem:", configuracoes);
        } else {
            throw new Error("Chave não encontrada na nuvem. Carregando padrão.");
        }
    } catch (error) {
        console.warn(error.message);
        // 2. Fallback para arquivo padrão local (com cache buster)
        try {
            const fallbackResponse = await fetch("Configuracoes_Padrao.json?v=" + new Date().getTime());
            configuracoes = await fallbackResponse.json();
            console.log("Configurações padrão carregadas localmente:", configuracoes);
            
            // Inicializa a nuvem com os dados padrão em segundo plano
            salvarDadosNuvem(configuracoes);
        } catch (localError) {
            console.error("Erro crítico ao carregar configurações de fallback:", localError);
        }
    }
    
    // Renderiza a tela após obter dados
    renderizarCardapio();
}

// Salva dados na nuvem (usado para bootstrap e pelo admin)
async function salvarDadosNuvem(dados) {
    try {
        await fetch(KVDB_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(dados)
        });
    } catch (e) {
        console.error("Erro ao sincronizar dados com o KVDB:", e);
    }
}

// Renderiza o cardápio na tela
function renderizarCardapio() {
    if (!configuracoes.itens) return;

    fatiasContainer.innerHTML = "";
    complementosContainer.innerHTML = "";

    let fatiasAtivas = 0;
    let complementosAtivos = 0;

    configuracoes.itens.forEach(item => {
        // Apenas exibe se estiver ativo
        if (!item.ativo) return;

        const card = document.createElement("div");
        card.className = "menu-card";
        card.id = `card-${item.id}`;

        const qtd = carrinho[item.id] || 0;

        card.innerHTML = `
            <div class="item-info">
                <div class="item-header">
                    <h3>${item.nome}</h3>
                    <p class="item-desc">${item.descricao || ''}</p>
                </div>
                <div class="item-footer">
                    <span class="item-price">R$ ${item.preco.toFixed(2)}</span>
                    <div class="qty-controls">
                        <button type="button" class="btn-qty minus" onclick="alterarQtd('${item.id}', -1)">−</button>
                        <span class="qty-val" id="qty-${item.id}">${qtd}</span>
                        <button type="button" class="btn-qty plus" onclick="alterarQtd('${item.id}', 1)">+</button>
                    </div>
                </div>
            </div>
        `;

        if (item.categoria === "Fatias") {
            fatiasContainer.appendChild(card);
            fatiasAtivas++;
        } else {
            complementosContainer.appendChild(card);
            complementosAtivos++;
        }
    });

    // Se as categorias estiverem vazias
    if (fatiasAtivas === 0) {
        fatiasContainer.innerHTML = '<div class="loading-state">Nenhum sabor de fatia disponível no momento.</div>';
    }
    if (complementosAtivos === 0) {
        complementosContainer.innerHTML = '<div class="loading-state">Nenhum acompanhamento disponível no momento.</div>';
    }
}

// Altera quantidade no carrinho
window.alterarQtd = function(itemId, delta) {
    const atual = carrinho[itemId] || 0;
    const novaQtd = Math.max(0, atual + delta);
    
    if (novaQtd === 0) {
        delete carrinho[itemId];
    } else {
        carrinho[itemId] = novaQtd;
    }

    // Atualiza o contador na tela
    const qtySpan = document.getElementById(`qty-${itemId}`);
    if (qtySpan) qtySpan.innerText = novaQtd;

    atualizarCarrinho();
};

// Calcula e atualiza barra inferior com suporte a subtotal e taxa de entrega por KM
function atualizarCarrinho() {
    let totalItens = 0;
    let subtotalItens = 0.0;
    let totalFatias = 0;
    let precoFatiasUnitario = configuracoes.preco_fatia || 15.00;
    let precoComboFatias = configuracoes.preco_combo || 25.00; // a cada 2 fatias

    // Passa pelos itens do carrinho para contar fatias e complementos
    for (const [id, qtd] of Object.entries(carrinho)) {
        const item = configuracoes.itens.find(i => i.id === id);
        if (!item) continue;

        totalItens += qtd;

        if (item.categoria === "Fatias") {
            totalFatias += qtd;
        } else {
            subtotalItens += item.preco * qtd;
        }
    }

    // Aplica o cálculo do combo escalado de fatias gourmet
    const totalCombos = Math.floor(totalFatias / 2);
    const totalAvulsas = totalFatias % 2;
    const precoTotalFatias = (totalCombos * precoComboFatias) + (totalAvulsas * precoFatiasUnitario);
    
    subtotalItens += precoTotalFatias;

    // Calcula taxa de entrega
    let taxa = 0.0;
    let textoTaxa = "Grátis";
    const metodoConsumo = document.querySelector('input[name="delivery_method"]:checked')?.value || "retirar";

    if (metodoConsumo === "delivery") {
        if (statusTaxa === "sucesso") {
            taxa = taxaEntregaCalculada;
            textoTaxa = `R$ ${taxa.toFixed(2)}`;
        } else if (statusTaxa === "calculando") {
            textoTaxa = "Calculando...";
        } else {
            textoTaxa = "A combinar";
        }
    }

    const totalGeral = subtotalItens + taxa;

    // Atualiza DOM da barra inferior
    if (totalItens > 0) {
        bottomBar.classList.remove("hidden");
        cartCount.innerText = totalItens;
        cartTotal.innerText = `R$ ${totalGeral.toFixed(2)}`;
        
        // Atualiza subtotal e entrega na tela
        const subtotalSpan = document.getElementById("cart-subtotal");
        const deliveryTaxSpan = document.getElementById("cart-delivery-tax");
        if (subtotalSpan) subtotalSpan.innerText = `R$ ${subtotalItens.toFixed(2)}`;
        if (deliveryTaxSpan) deliveryTaxSpan.innerText = textoTaxa;
        
        // Exibe economia caso o combo seja ativado
        if (totalCombos > 0) {
            const economia = (totalFatias * precoFatiasUnitario) - precoTotalFatias;
            comboDiscount.innerText = `Economia de R$ ${economia.toFixed(2)} aplicada!`;
            comboDiscount.classList.remove("hidden");
        } else {
            comboDiscount.classList.add("hidden");
        }

        // Gera o Pix Copia e Cola dinâmico com valor
        const chavePix = configuracoes.whatsapp || "22988441827";
        const nomeRecebedor = "DOUGLAS CASTRO";
        const cidadeRecebedor = "ARARUAMA";
        pixCopiaColaGerado = gerarPixCopiaCola(chavePix, totalGeral, nomeRecebedor, cidadeRecebedor);
        
        const btnText = document.getElementById("copy-pix-btn-text");
        if (btnText) {
            btnText.innerText = `Copiar PIX (R$ ${totalGeral.toFixed(2)})`;
        }
    } else {
        bottomBar.classList.add("hidden");
        const btnText = document.getElementById("copy-pix-btn-text");
        if (btnText) {
            btnText.innerText = "Copiar Código do PIX";
        }
        pixCopiaColaGerado = "";
    }
}

// Configura eventos da interface
function configurarEventos() {
    // Monitora mudança no método de entrega
    deliveryRadios.forEach(radio => {
        radio.addEventListener("change", (e) => {
            // Remove classe ativa de todos
            deliveryRadios.forEach(r => r.closest(".radio-label").classList.remove("active"));
            
            // Adiciona na selecionada
            e.target.closest(".radio-label").classList.add("active");

            // Controla exibição dos campos de endereço
            if (e.target.value === "delivery") {
                addressFields.classList.remove("hidden");
                definirCamposEnderecoObrigatorios(true);
                tentarCalcularTaxa();
            } else {
                addressFields.classList.add("hidden");
                definirCamposEnderecoObrigatorios(false);
            }
            
            atualizarCarrinho(); // Recalcula e atualiza barra de frete/total
        });
    });

    // Listeners de Endereço para cálculo automático da taxa de entrega
    const streetInput = document.getElementById("address-street");
    const numberInput = document.getElementById("address-number");
    const neighborhoodInput = document.getElementById("address-neighborhood");

    if (streetInput && numberInput && neighborhoodInput) {
        [streetInput, numberInput, neighborhoodInput].forEach(input => {
            input.addEventListener("change", tentarCalcularTaxa);
            input.addEventListener("blur", tentarCalcularTaxa);
        });
    }

    // Enviar Pedido via WhatsApp
    btnSubmitOrder.addEventListener("click", () => {
        enviarPedidoWhatsApp();
    });
}

// Define obrigatoriedade dos campos de entrega
function definirCamposEnderecoObrigatorios(obrigatorio) {
    const inputs = addressFields.querySelectorAll("input");
    inputs.forEach(input => {
        if (input.name !== "complement" && input.name !== "reference") {
            input.required = obrigatorio;
        }
    });
}

// Valida formulário e gera link do WhatsApp
function enviarPedidoWhatsApp() {
    // 1. Valida se o carrinho possui itens
    const totalItens = Object.values(carrinho).reduce((a, b) => a + b, 0);
    if (totalItens === 0) {
        alert("Papai, adicione pelo menos uma fatia ou doce antes de fechar o pedido!");
        return;
    }

    // 2. Valida o formulário principal
    if (!checkoutForm.checkValidity()) {
        checkoutForm.reportValidity();
        return;
    }

    // 3. Extrai dados do checkout
    const formData = new FormData(checkoutForm);
    const nome = formData.get("name");
    const telefone = formData.get("phone");
    const metodoConsumo = formData.get("delivery_method");
    const formaPagamento = formData.get("payment");

    // 4. Formata os itens para a mensagem
    let textoItens = "";
    let totalPreco = 0.0;
    let totalFatias = 0;
    let listagemFatias = [];
    let listagemOutros = [];

    let precoFatiasUnitario = configuracoes.preco_fatia || 15.00;
    let precoComboFatias = configuracoes.preco_combo || 25.00;

    for (const [id, qtd] of Object.entries(carrinho)) {
        const item = configuracoes.itens.find(i => i.id === id);
        if (!item) continue;

        if (item.categoria === "Fatias") {
            totalFatias += qtd;
            listagemFatias.push("   • " + qtd + "x " + item.nome);
        } else {
            listagemOutros.push("- " + qtd + "x " + item.nome + " (R$ " + (item.preco * qtd).toFixed(2) + ")");
            totalPreco += item.preco * qtd;
        }
    }

    // Detalha combos na mensagem
    const totalCombos = Math.floor(totalFatias / 2);
    const totalAvulsas = totalFatias % 2;
    const precoTotalFatias = (totalCombos * precoComboFatias) + (totalAvulsas * precoFatiasUnitario);
    totalPreco += precoTotalFatias;

    if (totalCombos > 0) {
        textoItens += "- " + totalCombos + "x Combo de 2 Fatias (R$ " + (totalCombos * precoComboFatias).toFixed(2) + ")\n";
    }
    if (totalAvulsas > 0) {
        textoItens += "- " + totalAvulsas + "x Fatia Avulsa (R$ " + (totalAvulsas * precoFatiasUnitario).toFixed(2) + ")\n";
    }
    
    // Lista os sabores das fatias logo abaixo
    if (listagemFatias.length > 0) {
        textoItens += "  *Sabores selecionados:*\n" + listagemFatias.join("\n") + "\n";
    }

    // Lista os acompanhamentos
    if (listagemOutros.length > 0) {
        textoItens += listagemOutros.join("\n") + "\n";
    }

    // 5. Formata método de entrega, endereço e total do WhatsApp
    let textoEntrega = "";
    let textoDetalheValores = "";

    if (metodoConsumo === "retirar") {
        textoEntrega = "🛍️ Retirar no Local";
        textoDetalheValores = "R$ " + totalPreco.toFixed(2);
    } else {
        const rua = formData.get("street");
        const numero = formData.get("number");
        const bairro = formData.get("neighborhood");
        const complemento = formData.get("complement") || "Não informado";
        const referencia = formData.get("reference") || "Não informado";

        let stringTaxa = "";
        if (statusTaxa === "sucesso") {
            stringTaxa = "R$ " + taxaEntregaCalculada.toFixed(2);
            const precoItens = totalPreco;
            totalPreco += taxaEntregaCalculada; // Soma a taxa ao total
            textoDetalheValores = "R$ " + totalPreco.toFixed(2) + " (Itens: R$ " + precoItens.toFixed(2) + " + Taxa: R$ " + taxaEntregaCalculada.toFixed(2) + ")";
        } else {
            stringTaxa = "A combinar";
            textoDetalheValores = "R$ " + totalPreco.toFixed(2) + " + Taxa a combinar no WhatsApp";
        }

        textoEntrega = "🛵 *Delivery*\n  • Rua: " + rua + ", Nº " + numero + "\n  • Bairro: " + bairro + " (Taxa: " + stringTaxa + ")\n  • Apto/Bloco: " + complemento + "\n  • Ref: " + referencia;
    }

    // Formata forma de pagamento
    const formasPgt = {
        pix: "Pix",
        credito: "Cartão de Crédito",
        debito: "Cartão de Débito",
        dinheiro: "Dinheiro"
    };

    // 6. Montagem final do texto do pedido
    const msg = 
"🍰 *NOVO PEDIDO - FESTIVAL DE FATIAS* 🍰\n" +
"----------------------------------\n" +
"👤 *Nome:* " + nome + "\n" +
"📞 *Contato:* " + telefone + "\n\n" +
"🛒 *Itens do Pedido:*\n" +
textoItens + "\n" +
"💳 *Forma de Pagamento:* " + formasPgt[formaPagamento] + "\n" +
"📍 *Forma de Consumo:* " + textoEntrega + "\n\n" +
"💵 *Total a Pagar:* " + textoDetalheValores + "\n" +
"----------------------------------\n" +
"_Pedido gerado via Cardápio Digital_";

    // 7. Envia para a API do WhatsApp
    const whatsappDestino = configuracoes.whatsapp || "5522988441827";
    const urlWa = "https://wa.me/" + whatsappDestino + "?text=" + encodeURIComponent(msg);
    window.open(urlWa, "_blank");
}

// Copia a Chave PIX Celular Manual
window.copiarChavePix = function() {
    const chavePix = "22988441827";
    navigator.clipboard.writeText(chavePix).then(() => {
        const btnText = document.getElementById("copy-chave-btn-text");
        if (btnText) {
            btnText.innerHTML = "Copiado! ";
            setTimeout(() => {
                btnText.innerHTML = "Copiar Chave";
            }, 2000);
        }
    }).catch(err => {
        console.error("Erro ao copiar: ", err);
        // Fallback em caso de erro de permissão do navegador
        const tempInput = document.createElement("input");
        tempInput.value = chavePix;
        document.body.appendChild(tempInput);
        tempInput.select();
        document.execCommand("copy");
        document.body.removeChild(tempInput);
        const btnText = document.getElementById("copy-chave-btn-text");
        if (btnText) {
            btnText.innerHTML = "Copiado! ";
            setTimeout(() => {
                btnText.innerHTML = "Copiar Chave";
            }, 2000);
        }
    });
};

// Copia o Código Pix Copia e Cola Dinâmico (Chave + Valor)
window.copiarPixCopiaCola = function() {
    if (!pixCopiaColaGerado) {
        alert("Papai, adicione pelo menos uma fatia ao carrinho para gerar o código Pix!");
        return;
    }
    navigator.clipboard.writeText(pixCopiaColaGerado).then(() => {
        const btnText = document.getElementById("copy-pix-btn-text");
        if (btnText) {
            btnText.innerHTML = "Copiado! ";
            setTimeout(() => {
                atualizarCarrinho();
            }, 2000);
        }
    }).catch(err => {
        console.error("Erro ao copiar Pix: ", err);
        // Fallback
        const tempInput = document.createElement("input");
        tempInput.value = pixCopiaColaGerado;
        document.body.appendChild(tempInput);
        tempInput.select();
        document.execCommand("copy");
        document.body.removeChild(tempInput);
        const btnText = document.getElementById("copy-pix-btn-text");
        if (btnText) {
            btnText.innerHTML = "Copiado! ";
            setTimeout(() => {
                atualizarCarrinho();
            }, 2000);
        }
    });
};

// Função para geração de PIX Estático no padrão EMV ( offline )
function gerarPixCopiaCola(chave, valor, nome, cidade, txid = "***") {
    // 1. Limpa a chave Pix caso tenha o prefixo 55
    let chaveLimpa = chave.replace(/\D/g, '');
    if (chaveLimpa.length === 13 && chaveLimpa.startsWith("55")) {
        chaveLimpa = chaveLimpa.substring(2);
    }
    
    const valorStr = parseFloat(valor).toFixed(2);
    
    function criarCampo(id, valorCampo) {
        const len = String(valorCampo).length.toString().padStart(2, '0');
        return id + len + valorCampo;
    }
    
    const gui = criarCampo("00", "br.gov.bcb.pix");
    const chaveFormatada = criarCampo("01", chaveLimpa);
    const merchantAccountInfo = criarCampo("26", gui + chaveFormatada);
    
    const txidCampo = criarCampo("05", txid);
    const additionalData = criarCampo("62", txidCampo);
    
    let payload = "";
    payload += criarCampo("00", "01"); // Payload Format Indicator
    payload += merchantAccountInfo;
    payload += criarCampo("52", "0000"); // Merchant Category Code
    payload += criarCampo("53", "986"); // Currency (Real = 986)
    payload += criarCampo("54", valorStr); // Transaction Amount
    payload += criarCampo("58", "BR"); // Country Code
    payload += criarCampo("59", nome.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
    payload += criarCampo("60", cidade.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
    payload += additionalData;
    payload += "6304"; // Cabeçalho do CRC16
    
    const crc = calcularCRC16(payload);
    return payload + crc;
}

function calcularCRC16(str) {
    let crc = 0xFFFF;
    const polynomial = 0x1021;
    
    for (let i = 0; i < str.length; i++) {
        let b = str.charCodeAt(i);
        for (let j = 0; j < 8; j++) {
            let bit = ((b >> (7 - j)) & 1) === 1;
            let c15 = ((crc >> 15) & 1) === 1;
            crc <<= 1;
            if (c15 ^ bit) {
                crc ^= polynomial;
            }
        }
    }
    
    crc &= 0xFFFF;
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

// Funções para Cálculo da Taxa de Entrega por KM Real (OpenStreetMap + OSRM)
function tentarCalcularTaxa() {
    const metodoConsumo = document.querySelector('input[name="delivery_method"]:checked')?.value || "retirar";
    if (metodoConsumo !== "delivery") return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
        const rua = document.getElementById("address-street").value.trim();
        const numero = document.getElementById("address-number").value.trim();
        const bairro = document.getElementById("address-neighborhood").value.trim();

        // Só calcula se os três campos principais estiverem preenchidos
        if (rua.length > 2 && numero.length > 0 && bairro.length > 2) {
            await executarCalculoTaxa(rua, numero, bairro);
        } else {
            taxaEntregaCalculada = 0.0;
            statusTaxa = "pendente";
            atualizarStatusTaxa("pendente", "Aguardando endereço completo para calcular a taxa de entrega...");
            atualizarCarrinho();
        }
    }, 600); // Debounce de 600ms para esperar o usuário terminar de digitar
}

async function executarCalculoTaxa(rua, numero, bairro) {
    statusTaxa = "calculando";
    atualizarStatusTaxa("calculando", "Calculando taxa de entrega...");
    atualizarCarrinho();

    try {
        const origemLat = configuracoes.origem_lat || -22.924822;
        const origemLon = configuracoes.origem_lon || -43.218520;
        const taxaMinima = configuracoes.taxa_minima || 3.00;
        const valorPorKm = configuracoes.valor_por_km || 1.00;

        // 1. Geocodificar endereço do cliente usando o Nominatim (OpenStreetMap)
        const query = `${rua}, ${numero} - ${bairro}, Rio de Janeiro, Brasil`;
        const urlGeocold = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;

        const responseGeo = await fetch(urlGeocold, {
            headers: {
                "Accept-Language": "pt-BR"
            }
        });

        if (!responseGeo.ok) throw new Error("Erro na geocodificação");

        const dataGeo = await responseGeo.json();
        if (!dataGeo || dataGeo.length === 0) {
            throw new Error("Endereço não localizado no mapa");
        }

        const latCliente = dataGeo[0].lat;
        const lonCliente = dataGeo[0].lon;

        // 2. Calcular rota de carro usando a API do OSRM (Open Source Routing Machine)
        const urlRoute = `https://router.project-osrm.org/route/v1/driving/${origemLon},${origemLat};${lonCliente},${latCliente}?overview=false`;
        const responseRoute = await fetch(urlRoute);

        if (!responseRoute.ok) throw new Error("Erro no cálculo da rota");

        const dataRoute = await responseRoute.json();
        if (!dataRoute.routes || dataRoute.routes.length === 0) {
            throw new Error("Não foi possível traçar uma rota de carro");
        }

        const distanciaMetros = dataRoute.routes[0].distance;
        const distanciaKm = distanciaMetros / 1000;

        // 3. Aplica a regra de negócio comercial
        taxaEntregaCalculada = Math.max(taxaMinima, distanciaKm * valorPorKm);
        statusTaxa = "sucesso";

        atualizarStatusTaxa("success", `Taxa calculada: R$ ${taxaEntregaCalculada.toFixed(2)} (Distância: ${distanciaKm.toFixed(1)} km de rota de carro)`);
    } catch (e) {
        console.warn("Falha no cálculo automático de frete:", e.message);
        taxaEntregaCalculada = 0.0;
        statusTaxa = "erro";
        atualizarStatusTaxa("error", "Endereço não localizado automaticamente. Taxa a combinar no WhatsApp.");
    }

    atualizarCarrinho();
}

function atualizarStatusTaxa(classe, texto) {
    const statusBox = document.getElementById("delivery-status-box");
    const statusIcon = document.getElementById("delivery-status-icon");
    const statusText = document.getElementById("delivery-status-text");

    if (statusBox && statusIcon && statusText) {
        statusBox.className = "delivery-status-box";
        
        let icon = "🔄";
        if (classe === "success") {
            statusBox.classList.add("success");
            icon = "✅";
        } else if (classe === "error") {
            statusBox.classList.add("error");
            icon = "⚠️";
        } else if (classe === "calculando") {
            statusBox.classList.add("calculando");
            icon = "🔄";
        } else {
            icon = "📍";
        }

        statusIcon.innerHTML = icon;
        statusText.innerHTML = texto;
    }
}

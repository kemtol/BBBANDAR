/**
 * Scalping Side by Side - 2 Emiten
 * Direct WebSocket Relay from Indopremier
 */

class ScalpingSBS {
    constructor() {
        this.ws = null;
        this.connected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 2000;
        
        // Emiten data
        this.emiten1 = {
            code: '',
            name: '',
            price: 0,
            prevPrice: 0,
            change: 0,
            changePercent: 0,
            dom: [],
            footprint: [],
            footprintMaxSize: 100
        };
        
        this.emiten2 = {
            code: '',
            name: '',
            price: 0,
            prevPrice: 0,
            change: 0,
            changePercent: 0,
            dom: [],
            footprint: [],
            footprintMaxSize: 100
        };
        
        // Settings
        this.domDepth = 10;
        this.soundEnabled = true;
        this.bigTradeAlert = false;
        this.bigTradeThreshold = 1000000; // 1 juta lot
        
        // Audio context for beep
        this.audioContext = null;
        
        this.init();
    }
    
    init() {
        this.initElements();
        this.initWebSocket();
        this.bindEvents();
        this.initAudio();
        this.renderEmptyState();
        this.renderScalpingPills();
    }
    
    initElements() {
        // Emiten 1 elements
        this.el = {
            code1: $('#code1'),
            name1: $('#name1'),
            price1: $('#price1'),
            change1: $('#change1'),
            dom1: $('#dom1'),
            footprint1: $('#footprint1'),
            
            // Emiten 2 elements
            code2: $('#code2'),
            name2: $('#name2'),
            price2: $('#price2'),
            change2: $('#change2'),
            dom2: $('#dom2'),
            footprint2: $('#footprint2'),
            
            // Controls
            pillList: $('#pillList'),
            btnReconnect: $('#btnReconnect'),
            connectionStatus: $('.connection-status'),
            soundToggle: $('#soundToggle'),
            alertToggle: $('#alertToggle'),
            domDepth: $('#domDepth')
        };
    }
    
    initAudio() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.warn('Audio context not supported');
        }
    }
    
    playBeep(frequency = 800, duration = 50, type = 'sine') {
        if (!this.soundEnabled || !this.audioContext) return;
        
        try {
            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);
            
            oscillator.frequency.value = frequency;
            oscillator.type = type;
            
            gainNode.gain.setValueAtTime(0.1, this.audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration / 1000);
            
            oscillator.start(this.audioContext.currentTime);
            oscillator.stop(this.audioContext.currentTime + duration / 1000);
        } catch (e) {
            console.warn('Audio play failed:', e);
        }
    }
    
    bindEvents() {
        // Reconnect button
        this.el.btnReconnect.on('click', () => this.reconnect());
        
        // Pill click - delegate to container
        this.el.pillList.on('click', '.scalping-pill', (e) => {
            const code = $(e.currentTarget).data('code');
            this.loadEmitenFromPill(code);
        });
        
        // Settings
        this.el.soundToggle.on('change', (e) => {
            this.soundEnabled = $(e.target).is(':checked');
        });
        
        this.el.alertToggle.on('change', (e) => {
            this.bigTradeAlert = $(e.target).is(':checked');
        });
        
        this.el.domDepth.on('change', (e) => {
            this.domDepth = parseInt($(e.target).val());
            this.renderDOM(1);
            this.renderDOM(2);
        });
        
        // Auto-resume audio context on user interaction
        $(document).one('click', () => {
            if (this.audioContext && this.audioContext.state === 'suspended') {
                this.audioContext.resume();
            }
        });
    }
    
    renderScalpingPills(candidates) {
        const pills = candidates || this.getDefaultScalpingCandidates();
        let html = '';
        
        pills.forEach(pill => {
            const isActive = pill.code === this.emiten1.code || pill.code === this.emiten2.code;
            html += `
                <div class="scalping-pill ${isActive ? 'active' : ''}" data-code="${pill.code}">
                    ${pill.code}
                </div>
            `;
        });
        
        this.el.pillList.html(html);
    }
    
    getDefaultScalpingCandidates() {
        // Default high liquidity candidates for scalping
        return [
            { code: 'BBCA', volume: 'High' },
            { code: 'BBRI', volume: 'High' },
            { code: 'TLKM', volume: 'High' },
            { code: 'ASII', volume: 'Med' },
            { code: 'BMRI', volume: 'High' },
            { code: 'UNVR', volume: 'Med' },
            { code: 'PGAS', volume: 'High' },
            { code: 'INDF', volume: 'Med' }
        ];
    }
    
    loadEmitenFromPill(code) {
        if (!code) return;
        
        // If emiten1 is empty or same as clicked, load to emiten1
        if (!this.emiten1.code || this.emiten1.code === code) {
            this.loadSingleEmiten(code, 1);
        } else if (!this.emiten2.code || this.emiten2.code === code) {
            this.loadSingleEmiten(code, 2);
        } else {
            // Both filled, replace emiten2 (or could rotate)
            this.loadSingleEmiten(code, 2);
        }
        
        this.renderScalpingPills();
    }
    
    loadSingleEmiten(code, slot) {
        if (slot === 1) {
            if (this.emiten1.code && this.emiten1.code !== code) {
                this.unsubscribe(this.emiten1.code);
            }
            this.emiten1.code = code;
            this.emiten1.name = this.getEmitenName(code);
            this.subscribe(code);
        } else {
            if (this.emiten2.code && this.emiten2.code !== code) {
                this.unsubscribe(this.emiten2.code);
            }
            this.emiten2.code = code;
            this.emiten2.name = this.getEmitenName(code);
            this.subscribe(code);
        }
        
        this.updateHeaderDisplay();
        this.renderDOM(slot);
    }
    
    initWebSocket() {
        // TODO: Update with actual Indopremier WebSocket relay URL
        const wsUrl = 'wss://your-websocket-relay-url';
        
        try {
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                this.connected = true;
                this.reconnectAttempts = 0;
                this.updateConnectionStatus(true);
                
                // Subscribe to emiten if already loaded
                if (this.emiten1.code) this.subscribe(this.emiten1.code);
                if (this.emiten2.code) this.subscribe(this.emiten2.code);
            };
            
            this.ws.onmessage = (event) => {
                this.handleMessage(JSON.parse(event.data));
            };
            
            this.ws.onclose = () => {
                this.connected = false;
                this.updateConnectionStatus(false);
                this.scheduleReconnect();
            };
            
            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.connected = false;
                this.updateConnectionStatus(false);
            };
        } catch (e) {
            console.error('Failed to create WebSocket:', e);
            this.scheduleReconnect();
        }
    }
    
    scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('Max reconnect attempts reached');
            return;
        }
        
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5);
        
        setTimeout(() => {
            this.initWebSocket();
        }, delay);
    }
    
    reconnect() {
        if (this.ws) {
            this.ws.close();
        }
        this.reconnectAttempts = 0;
        this.initWebSocket();
    }
    
    subscribe(code) {
        if (!this.connected || !code) return;
        
        this.ws.send(JSON.stringify({
            action: 'subscribe',
            code: code.toUpperCase()
        }));
    }
    
    unsubscribe(code) {
        if (!this.connected || !code) return;
        
        this.ws.send(JSON.stringify({
            action: 'unsubscribe',
            code: code.toUpperCase()
        }));
    }
    
    handleMessage(data) {
        // Determine which emiten this message belongs to
        const code = data.code || data.stock || data.emiten;
        
        if (!code) return;
        
        const upperCode = code.toUpperCase();
        
        if (upperCode === this.emiten1.code) {
            this.processData(data, 1);
        } else if (upperCode === this.emiten2.code) {
            this.processData(data, 2);
        }
    }
    
    processData(data, emitenNum) {
        const emiten = emitenNum === 1 ? this.emiten1 : this.emiten2;
        
        // Update price
        if (data.price || data.last || data.close) {
            const newPrice = data.price || data.last || data.close;
            emiten.prevPrice = emiten.price;
            emiten.price = parseFloat(newPrice);
            
            // Calculate change
            if (data.open || data.prevClose) {
                const openPrice = data.open || data.prevClose;
                emiten.change = emiten.price - openPrice;
                emiten.changePercent = (emiten.change / openPrice) * 100;
            }
            
            this.updatePriceDisplay(emitenNum);
        }
        
        // Update DOM (Order Book)
        if (data.dom || data.orderbook || data.depth) {
            const domData = data.dom || data.orderbook || data.depth;
            emiten.dom = this.parseDOM(domData);
            this.renderDOM(emitenNum);
        }
        
        // Update Footprint (Trade Data)
        if (data.trade || data.transaction || data.footprint) {
            const tradeData = data.trade || data.transaction || data.footprint;
            this.addFootprint(tradeData, emitenNum);
        }
        
        // Play sound on price change (if enabled)
        if (this.soundEnabled && emiten.price !== emiten.prevPrice && emiten.prevPrice !== 0) {
            const freq = emiten.price > emiten.prevPrice ? 1000 : 600;
            this.playBeep(freq, 30);
        }
    }
    
    parseDOM(domData) {
        // Parse various DOM formats
        if (Array.isArray(domData)) {
            return domData.slice(0, this.domDepth);
        }
        return [];
    }
    
    addFootprint(tradeData, emitenNum) {
        const emiten = emitenNum === 1 ? this.emiten1 : this.emiten2;
        
        const footprint = {
            time: new Date(),
            price: tradeData.price || tradeData.tradePrice || 0,
            volume: tradeData.volume || tradeData.lot || tradeData.qty || 0,
            type: this.determineTradeType(tradeData, emiten)
        };
        
        // Check for big trade
        if (this.bigTradeAlert && footprint.volume >= this.bigTradeThreshold) {
            footprint.bigTrade = true;
            this.playBeep(1500, 100, 'square');
        }
        
        emiten.footprint.unshift(footprint);
        
        // Limit footprint size
        if (emiten.footprint.length > emiten.footprintMaxSize) {
            emiten.footprint.pop();
        }
        
        this.renderFootprint(emitenNum);
    }
    
    determineTradeType(tradeData, emiten) {
        // Determine if trade is buy or sell based on price relative to bid/ask
        if (tradeData.type) {
            return tradeData.type.toLowerCase().includes('buy') ? 'buy' : 'sell';
        }
        
        if (emiten.dom && emiten.dom.length > 0) {
            const bestBid = emiten.dom[0]?.bid || 0;
            const bestAsk = emiten.dom[0]?.ask || 0;
            const tradePrice = tradeData.price || tradeData.tradePrice || 0;
            
            if (tradePrice >= bestAsk) return 'buy';
            if (tradePrice <= bestBid) return 'sell';
        }
        
        return 'neutral';
    }
    
    loadEmiten() {
        const code1 = this.el.inputCode1.val().toUpperCase().trim();
        const code2 = this.el.inputCode2.val().toUpperCase().trim();
        
        if (!code1 && !code2) {
            alert('Masukkan minimal 1 kode emiten');
            return;
        }
        
        // Unsubscribe old codes
        if (this.emiten1.code && this.emiten1.code !== code1) {
            this.unsubscribe(this.emiten1.code);
        }
        if (this.emiten2.code && this.emiten2.code !== code2) {
            this.unsubscribe(this.emiten2.code);
        }
        
        // Load Emiten 1
        if (code1) {
            this.emiten1.code = code1;
            this.emiten1.name = this.getEmitenName(code1);
            this.subscribe(code1);
        }
        
        // Load Emiten 2
        if (code2) {
            this.emiten2.code = code2;
            this.emiten2.name = this.getEmitenName(code2);
            this.subscribe(code2);
        }
        
        this.updateHeaderDisplay();
        this.renderDOM(1);
        this.renderDOM(2);
    }
    
    getEmitenName(code) {
        // TODO: Fetch from API or local database
        // For now, return generic name
        return `PT ${code} Tbk`;
    }
    
    clearAll() {
        this.unsubscribe(this.emiten1.code);
        this.unsubscribe(this.emiten2.code);
        
        this.emiten1 = {
            code: '', name: '', price: 0, prevPrice: 0, change: 0, changePercent: 0,
            dom: [], footprint: [], footprintMaxSize: 100
        };
        
        this.emiten2 = {
            code: '', name: '', price: 0, prevPrice: 0, change: 0, changePercent: 0,
            dom: [], footprint: [], footprintMaxSize: 100
        };
        
        this.el.inputCode1.val('');
        this.el.inputCode2.val('');
        
        this.updateHeaderDisplay();
        this.renderEmptyState();
    }
    
    updateHeaderDisplay() {
        // Emiten 1
        this.el.code1.text(this.emiten1.code || 'EMITEN1');
        this.el.name1.text(this.emiten1.name || 'Nama Emiten 1');
        
        // Emiten 2
        this.el.code2.text(this.emiten2.code || 'EMITEN2');
        this.el.name2.text(this.emiten2.name || 'Nama Emiten 2');
    }
    
    updatePriceDisplay(emitenNum) {
        const emiten = emitenNum === 1 ? this.emiten1 : this.emiten2;
        const elPrice = emitenNum === 1 ? this.el.price1 : this.el.price2;
        const elChange = emitenNum === 1 ? this.el.change1 : this.el.change2;
        
        elPrice.text(this.formatPrice(emiten.price));
        
        const changeText = `${emiten.change >= 0 ? '+' : ''}${this.formatPrice(emiten.change)} (${emiten.changePercent >= 0 ? '+' : ''}${emiten.changePercent.toFixed(2)}%)`;
        elChange.text(changeText);
        
        // Update color classes
        elChange.removeClass('up down neutral');
        if (emiten.change > 0) elChange.addClass('up');
        else if (emiten.change < 0) elChange.addClass('down');
        else elChange.addClass('neutral');
    }
    
    renderDOM(emitenNum) {
        const emiten = emitenNum === 1 ? this.emiten1 : this.emiten2;
        const elDom = emitenNum === 1 ? this.el.dom1 : this.el.dom2;
        
        if (!emiten.code) {
            this.renderEmptyDOM(elDom);
            return;
        }
        
        let html = '';
        
        if (emiten.dom.length === 0) {
            // Generate sample DOM for UI preview
            for (let i = 0; i < this.domDepth; i++) {
                html += this.renderDOMRow({}, i, emiten);
            }
        } else {
            emiten.dom.forEach((row, index) => {
                html += this.renderDOMRow(row, index, emiten);
            });
        }
        
        elDom.html(html);
    }
    
    renderDOMRow(row, index, emiten) {
        const bidLot = row.bidLot || row.bid || '';
        const askLot = row.askLot || row.ask || '';
        const price = row.price || (emiten.price ? emiten.price + (index - this.domDepth/2) * 5 : 0);
        
        const bidWidth = bidLot ? Math.min((bidLot / 10000) * 100, 100) : 0;
        const askWidth = askLot ? Math.min((askLot / 10000) * 100, 100) : 0;
        
        return `
            <div class="dom-row">
                <div class="dom-bid-lot">${bidLot ? this.formatVolume(bidLot) : ''}</div>
                <div class="dom-price">${price ? this.formatPrice(price) : '-'}</div>
                <div class="dom-ask-lot">${askLot ? this.formatVolume(askLot) : ''}</div>
            </div>
        `;
    }
    
    renderFootprint(emitenNum) {
        const emiten = emitenNum === 1 ? this.emiten1 : this.emiten2;
        const elFootprint = emitenNum === 1 ? this.el.footprint1 : this.el.footprint2;
        
        if (!emiten.code) {
            this.renderEmptyFootprint(elFootprint);
            return;
        }
        
        let html = '';
        
        if (emiten.footprint.length === 0) {
            elFootprint.html(`
                <div class="empty-state">
                    <div class="empty-state-icon">[ ]</div>
                    <div class="empty-state-text">Menunggu data transaksi...</div>
                </div>
            `);
            return;
        }
        
        emiten.footprint.forEach(fp => {
            html += `
                <div class="footprint-row ${fp.type} ${fp.bigTrade ? 'big-trade' : ''}">
                    <span class="fp-time">${this.formatTime(fp.time)}</span>
                    <span class="fp-price ${fp.type}">${this.formatPrice(fp.price)}</span>
                    <span class="fp-vol">${this.formatVolume(fp.volume)}</span>
                    <span class="fp-type ${fp.type}">${fp.type.toUpperCase()}</span>
                </div>
            `;
        });
        
        elFootprint.html(html);
    }
    
    renderEmptyState() {
        this.renderEmptyDOM(this.el.dom1);
        this.renderEmptyDOM(this.el.dom2);
        this.renderEmptyFootprint(this.el.footprint1);
        this.renderEmptyFootprint(this.el.footprint2);
    }
    
    renderEmptyDOM(el) {
        el.html(`
            <div class="empty-state">
                <div class="empty-state-icon">[ ]</div>
                <div class="empty-state-text">Input kode emiten di bawah</div>
            </div>
        `);
    }
    
    renderEmptyFootprint(el) {
        el.html(`
            <div class="empty-state">
                <div class="empty-state-icon">[ ]</div>
                <div class="empty-state-text">Footprint akan muncul disini</div>
            </div>
        `);
    }
    
    updateConnectionStatus(connected) {
        this.el.connectionStatus
            .toggleClass('connected', connected)
            .toggleClass('disconnected', !connected)
            .text(connected ? '● Connected' : '● Disconnected');
        
        // Show/hide reconnect icon
        const reconnectBtn = $('#btnReconnect');
        if (connected) {
            reconnectBtn.removeClass('show');
        } else {
            reconnectBtn.addClass('show');
        }
    }
    
    formatPrice(price) {
        if (!price || isNaN(price)) return '-';
        return price.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }
    
    formatVolume(volume) {
        if (!volume || isNaN(volume)) return '-';
        if (volume >= 1000000) {
            return (volume / 1000000).toFixed(1) + 'M';
        } else if (volume >= 1000) {
            return (volume / 1000).toFixed(1) + 'K';
        }
        return volume.toLocaleString('id-ID');
    }
    
    formatTime(date) {
        if (!date) return '--:--:--';
        const d = new Date(date);
        return d.toTimeString().split(' ')[0];
    }
}

// Initialize on document ready
$(document).ready(() => {
    window.scalpingSBS = new ScalpingSBS();
});

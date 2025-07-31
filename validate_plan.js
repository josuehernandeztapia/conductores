// Comprehensive validation script for plan.html
document.addEventListener('DOMContentLoaded', function() {
    console.log('🔍 Starting Plan.html Validation...');
    
    const results = {
        charts: {},
        interactions: {},
        data: {},
        errors: []
    };
    
    // 1. Chart Validation
    function validateCharts() {
        console.log('📊 Validating Charts...');
        
        // Check if Chart.js is loaded
        if (typeof Chart === 'undefined') {
            results.errors.push('Chart.js library not loaded');
            results.charts.library = false;
            return;
        }
        results.charts.library = true;
        
        // Check individual charts
        const chartIds = ['investmentDonutChart', 'financialPlanChart', 'roiComparisonChart'];
        
        chartIds.forEach(chartId => {
            const canvas = document.getElementById(chartId);
            if (!canvas) {
                results.errors.push(`Canvas element ${chartId} not found`);
                results.charts[chartId] = false;
                return;
            }
            
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                results.errors.push(`Cannot get 2D context for ${chartId}`);
                results.charts[chartId] = false;
                return;
            }
            
            // Check if chart is actually rendered
            setTimeout(() => {
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const hasData = imageData.data.some(pixel => pixel !== 0);
                results.charts[chartId] = hasData;
                console.log(`Chart ${chartId}: ${hasData ? '✅ Rendered' : '❌ Not rendered'}`);
            }, 1000);
        });
    }
    
    // 2. Interactive Elements Validation
    function validateInteractions() {
        console.log('🎛️ Validating Interactive Elements...');
        
        // Test sliders
        const sliders = ['month-slider', 'roi-years'];
        sliders.forEach(sliderId => {
            const slider = document.getElementById(sliderId);
            if (slider) {
                results.interactions[sliderId] = true;
                // Test slider functionality
                const originalValue = slider.value;
                slider.value = slider.max;
                slider.dispatchEvent(new Event('input'));
                slider.value = originalValue;
                slider.dispatchEvent(new Event('input'));
            } else {
                results.interactions[sliderId] = false;
                results.errors.push(`Slider ${sliderId} not found`);
            }
        });
        
        // Test modals
        const modals = ['agent-modal', 'legal-modal', 'glossary-modal'];
        modals.forEach(modalId => {
            const modal = document.getElementById(modalId);
            results.interactions[modalId] = modal !== null;
            if (!modal) {
                results.errors.push(`Modal ${modalId} not found`);
            }
        });
        
        // Test agent cards
        const agentCards = document.querySelectorAll('.agent-card');
        results.interactions.agentCards = agentCards.length;
        if (agentCards.length === 0) {
            results.errors.push('No agent cards found');
        }
        
        // Test phase cards
        const phaseCards = document.querySelectorAll('.phase-card');
        results.interactions.phaseCards = phaseCards.length;
        if (phaseCards.length === 0) {
            results.errors.push('No phase cards found');
        }
        
        // Test navigation links
        const navLinks = document.querySelectorAll('.nav-link');
        results.interactions.navLinks = navLinks.length;
        
        // Test HR table filters
        const roleFilter = document.getElementById('role-filter');
        const monthFilter = document.getElementById('month-filter');
        results.interactions.roleFilter = roleFilter !== null;
        results.interactions.monthFilter = monthFilter !== null;
    }
    
    // 3. Data Display Validation
    function validateDataDisplay() {
        console.log('📋 Validating Data Display...');
        
        // Check KPI cards
        const kpiCards = document.querySelectorAll('.kpi-card');
        results.data.kpiCards = kpiCards.length;
        
        // Check if KPI values are populated
        const kpiElements = ['kpi-gasto-mes', 'kpi-gasto-acumulado', 'kpi-efectivo'];
        kpiElements.forEach(kpiId => {
            const element = document.getElementById(kpiId);
            if (element) {
                results.data[kpiId] = element.textContent.length > 0;
            } else {
                results.data[kpiId] = false;
                results.errors.push(`KPI element ${kpiId} not found`);
            }
        });
        
        // Check HR table
        const hrTable = document.getElementById('hr-table');
        if (hrTable) {
            const rows = hrTable.querySelectorAll('tbody tr');
            results.data.hrTableRows = rows.length;
        } else {
            results.data.hrTableRows = 0;
            results.errors.push('HR table not found');
        }
        
        // Check timeline containers
        const techTimeline = document.getElementById('tech-timeline-container');
        const opsTimeline = document.getElementById('ops-timeline-container');
        results.data.techTimeline = techTimeline !== null;
        results.data.opsTimeline = opsTimeline !== null;
    }
    
    // 4. Console Error Detection
    function detectConsoleErrors() {
        const originalError = console.error;
        const originalWarn = console.warn;
        
        console.error = function(...args) {
            results.errors.push(`Console Error: ${args.join(' ')}`);
            originalError.apply(console, args);
        };
        
        console.warn = function(...args) {
            results.errors.push(`Console Warning: ${args.join(' ')}`);
            originalWarn.apply(console, args);
        };
    }
    
    // 5. Generate Report
    function generateReport() {
        console.log('📄 Generating Validation Report...');
        
        const report = document.createElement('div');
        report.id = 'validation-report';
        report.style.cssText = `
            position: fixed;
            top: 10px;
            right: 10px;
            width: 300px;
            max-height: 80vh;
            overflow-y: auto;
            background: white;
            border: 2px solid #0d9488;
            border-radius: 8px;
            padding: 15px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            z-index: 10000;
            font-family: monospace;
            font-size: 12px;
        `;
        
        let html = '<h3 style="margin: 0 0 10px 0; color: #0d9488;">Validation Report</h3>';
        
        // Charts section
        html += '<h4>📊 Charts:</h4>';
        Object.entries(results.charts).forEach(([key, value]) => {
            const status = value ? '✅' : '❌';
            html += `<div>${status} ${key}</div>`;
        });
        
        // Interactions section
        html += '<h4>🎛️ Interactions:</h4>';
        Object.entries(results.interactions).forEach(([key, value]) => {
            const status = typeof value === 'boolean' ? (value ? '✅' : '❌') : `📊 ${value}`;
            html += `<div>${status} ${key}</div>`;
        });
        
        // Data section
        html += '<h4>📋 Data:</h4>';
        Object.entries(results.data).forEach(([key, value]) => {
            const status = typeof value === 'boolean' ? (value ? '✅' : '❌') : `📊 ${value}`;
            html += `<div>${status} ${key}</div>`;
        });
        
        // Errors section
        if (results.errors.length > 0) {
            html += '<h4>🚨 Errors:</h4>';
            results.errors.forEach(error => {
                html += `<div style="color: red;">❌ ${error}</div>`;
            });
        } else {
            html += '<h4>🚨 Errors:</h4><div style="color: green;">✅ No errors detected</div>';
        }
        
        // Add close button
        html += '<button onclick="this.parentElement.remove()" style="margin-top: 10px; padding: 5px 10px; background: #0d9488; color: white; border: none; border-radius: 4px; cursor: pointer;">Close</button>';
        
        report.innerHTML = html;
        document.body.appendChild(report);
        
        // Also log to console
        console.log('🔍 Validation Results:', results);
    }
    
    // Run validation
    detectConsoleErrors();
    validateCharts();
    validateInteractions();
    validateDataDisplay();
    
    // Generate report after a delay to allow charts to render
    setTimeout(generateReport, 2000);
});
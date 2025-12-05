// Main JavaScript for DQ Dashboard
const API_BASE = '/api';
let currentAnalysis = null;
let currentWeights = null;
let currentWeightedSummary = null;
let generatedRules = [];
let detectedDomain = null;

// Initialize app
document.addEventListener('DOMContentLoaded', function() {
    initializeApp();
    setupEventListeners();
});

function initializeApp() {
    loadOverallStats();
    checkLLMStatus();
    setupNavigation();
    
    // Load domains from database as default (if no CSV analyzed)
    loadDomainsFromDatabase();
    
    // Initialize DQ Rules as empty on page load
    renderDynamicRules([]);
}

function setupEventListeners() {
    const csvFileUpload = document.getElementById('csvFileUpload');
    if (csvFileUpload) {
        csvFileUpload.addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (file) {
                const fileNameDisplay = document.getElementById('csvFileName');
                if (fileNameDisplay) {
                    fileNameDisplay.textContent = `Selected: ${file.name}`;
                }
                const analyzeBtn = document.getElementById('csvAnalyzeBtn');
                if (analyzeBtn) {
                    analyzeBtn.style.display = 'inline-flex';
                }
            }
        });
    }
}

function setupNavigation() {
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const page = this.dataset.page;
            showPage(page);
            if (page === 'weighted') {
                renderWeightedTable();
            }
            navLinks.forEach(l => l.classList.remove('active'));
            this.classList.add('active');
        });
    });
}

function showPage(pageName) {
    const pages = document.querySelectorAll('.page');
    pages.forEach(page => page.classList.remove('active'));
    const target = document.getElementById(`${pageName}Page`);
    if (target) {
        target.classList.add('active');
    }
    
    // When navigating to rules page, generate dynamic rules from detected issues
    if (pageName === 'rules' && window.currentIssues && window.currentIssues.length > 0) {
        generateDynamicRules(window.currentIssues, window.currentFieldAnalyses);
    }
    
    // Update nav link active state
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
        if (link.dataset.page === pageName) {
            link.classList.add('active');
        } else {
            link.classList.remove('active');
        }
    });
}

// Back to Dashboard - resets to manual domain selection
function backToDashboard() {
    console.log('>>> backToDashboard() called');
    resetToManualDomainSelection();
    showPage('dashboard');
    showToast('Domain selection reset to manual mode', 'info');
}

// API Calls
async function loadOverallStats() {
    try {
        const response = await fetch(`${API_BASE}/stats/overall`);
        const data = await response.json();
        
        if (data.success) {
            // Initialize dashboard overview with default values
            document.getElementById('totalRecords').textContent = '0';
            document.getElementById('totalTables').textContent = '0';
            document.getElementById('avgQuality').textContent = '0%';
            document.getElementById('totalIssues').textContent = '0';
        }
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

async function checkLLMStatus() {
    try {
        const response = await fetch(`${API_BASE}/llm/test`);
        const data = await response.json();
        
        const statusElement = document.getElementById('llmStatus');
        const statusText = document.getElementById('llmStatusText');
        const adminStatus = document.getElementById('adminLLMStatus');
        
        if (data.success) {
            statusElement.classList.add('online');
            statusText.textContent = `${data.model} Connected`;
            if (adminStatus) adminStatus.textContent = '✓ Connected';
        } else {
            statusElement.classList.add('offline');
            statusText.textContent = 'LLM Offline';
            if (adminStatus) adminStatus.textContent = '✗ Disconnected';
        }
    } catch (error) {
        console.error('Error checking LLM status:', error);
    }
}

function updateDashboardOverview(analysis, tableName) {
    // Update dashboard stats based on current analysis
    if (!analysis || !analysis.table_scores) return;
    
    // Update stat cards with analysis data
    document.getElementById('totalRecords').textContent = (analysis.total_records || 0).toLocaleString();
    document.getElementById('totalTables').textContent = '1';
    const dashboardScore = currentWeightedSummary ? currentWeightedSummary.tableScores.overall_score : analysis.table_scores.overall_score;
    document.getElementById('avgQuality').textContent = `${dashboardScore.toFixed(1)}%`;
    document.getElementById('totalIssues').textContent = (analysis.issues || []).length;
}

function initializeWeightConfig(analysis, tableName) {
    if (!analysis || !Array.isArray(analysis.field_analyses) || analysis.field_analyses.length === 0) {
        currentWeights = null;
        currentWeightedSummary = null;
        return;
    }
    if (currentWeights && currentWeights.tableName === tableName) {
        const existingFields = Object.keys(currentWeights.perField || {});
        if (existingFields.length === analysis.field_analyses.length) {
            return;
        }
    }
    const perField = {};
    const importanceDenominator = analysis.field_analyses.reduce((sum, field) => sum + (field.overall_score || 0), 0);
    analysis.field_analyses.forEach(field => {
        const completenessScore = (field.completeness_score || 0) / 100;
        const correctnessScore = (field.correctness_score || 0) / 100;
        const uniquenessScore = (field.uniqueness_score || 0) / 100;
        const total = completenessScore + correctnessScore + uniquenessScore;
        let completenessWeight = 1 / 3;
        let correctnessWeight = 1 / 3;
        let uniquenessWeight = 1 / 3;
        if (total > 0) {
            completenessWeight = completenessScore / total;
            correctnessWeight = correctnessScore / total;
            uniquenessWeight = uniquenessScore / total;
        }
        let importanceWeight = 1 / analysis.field_analyses.length;
        if (importanceDenominator > 0) {
            importanceWeight = (field.overall_score || 0) / importanceDenominator;
        }
        perField[field.field_name] = {
            completeness: clampToRange(completenessWeight),
            correctness: clampToRange(correctnessWeight),
            uniqueness: clampToRange(uniquenessWeight),
            importance: clampToRange(importanceWeight)
        };
    });
    const importanceSum = Object.values(perField).reduce((sum, config) => sum + config.importance, 0);
    if (importanceSum > 0) {
        Object.values(perField).forEach(config => {
            config.importance = clampToRange(config.importance / importanceSum);
        });
    }
    currentWeights = {
        tableName,
        perField
    };
    currentWeightedSummary = computeWeightedSummary(analysis);
}

function renderWeightedTable() {
    const content = document.getElementById('weightedContent');
    const emptyState = document.getElementById('weightedEmptyState');
    const actions = document.getElementById('weightedActions');
    const headerTitle = document.querySelector('#weightedPage .page-header h2');
    if (!content || !emptyState || !actions) {
        return;
    }
    if (!currentAnalysis || !currentWeights) {
        content.style.display = 'none';
        emptyState.style.display = 'flex';
        actions.style.display = 'none';
        if (headerTitle) {
            headerTitle.textContent = 'Weighted Analysis';
        }
        return;
    }
    const { tableName } = currentWeights;
    if (headerTitle && tableName) {
        headerTitle.textContent = `Weighted Analysis - ${tableName}`;
    }
    let html = `
    <div style="overflow-x: auto; border: 1px solid #e2e8f0; border-radius: 0.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
        <table style="width: 100%; border-collapse: collapse; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            <thead>
                <tr style="background: linear-gradient(135deg, #1d4ed8 0%, #3b82f6 100%); color: white;">
                    <th style="padding: 1rem; text-align: left; font-weight: 700;">Field Name</th>
                    <th style="padding: 1rem; text-align: center; font-weight: 700;">Completeness Score</th>
                    <th style="padding: 1rem; text-align: center; font-weight: 700;">Completeness Weight</th>
                    <th style="padding: 1rem; text-align: center; font-weight: 700;">Correctness Score</th>
                    <th style="padding: 1rem; text-align: center; font-weight: 700;">Correctness Weight</th>
                    <th style="padding: 1rem; text-align: center; font-weight: 700;">Uniqueness Score</th>
                    <th style="padding: 1rem; text-align: center; font-weight: 700;">Uniqueness Weight</th>
                    <th style="padding: 1rem; text-align: center; font-weight: 700;">Column Importance</th>
                </tr>
            </thead>
            <tbody>
    `;
    currentAnalysis.field_analyses.forEach((field, idx) => {
        const weights = getFieldWeights(field.field_name);
        const rowBg = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
        html += `
                <tr data-weight-row="${field.field_name}" style="background: ${rowBg}; border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 1rem; font-weight: 600; color: #1e293b;">${field.field_name}</td>
                    <td style="padding: 1rem; text-align: center; color: #0f172a; font-weight: 600;">${(field.completeness_score / 100).toFixed(2)}</td>
                    <td style="padding: 1rem; text-align: center;"><input type="number" class="weight-input" data-field="${field.field_name}" data-metric="completeness" min="0" max="1" step="0.01" value="${weights.completeness.toFixed(2)}" style="width: 80px; padding: 0.25rem 0.5rem; text-align: center;"></td>
                    <td style="padding: 1rem; text-align: center; color: #0f172a; font-weight: 600;">${(field.correctness_score / 100).toFixed(2)}</td>
                    <td style="padding: 1rem; text-align: center;"><input type="number" class="weight-input" data-field="${field.field_name}" data-metric="correctness" min="0" max="1" step="0.01" value="${weights.correctness.toFixed(2)}" style="width: 80px; padding: 0.25rem 0.5rem; text-align: center;"></td>
                    <td style="padding: 1rem; text-align: center; color: #0f172a; font-weight: 600;">${(field.uniqueness_score / 100).toFixed(2)}</td>
                    <td style="padding: 1rem; text-align: center;"><input type="number" class="weight-input" data-field="${field.field_name}" data-metric="uniqueness" min="0" max="1" step="0.01" value="${weights.uniqueness.toFixed(2)}" style="width: 80px; padding: 0.25rem 0.5rem; text-align: center;"></td>
                    <td style="padding: 1rem; text-align: center;"><input type="number" class="weight-input" data-field="${field.field_name}" data-metric="importance" min="0" max="1" step="0.01" value="${weights.importance.toFixed(2)}" style="width: 80px; padding: 0.25rem 0.5rem; text-align: center;"></td>
                </tr>
        `;
    });
    html += `
            </tbody>
        </table>
    </div>
    `;
    content.innerHTML = html;
    content.style.display = 'block';
    emptyState.style.display = 'none';
    actions.style.display = 'flex';
}

function saveWeightAdjustments() {
    if (!currentWeights || !currentAnalysis) {
        return;
    }
    const inputs = document.querySelectorAll('.weight-input');
    if (!inputs.length) {
        return;
    }
    const updated = {};
    inputs.forEach(input => {
        const field = input.dataset.field;
        const metric = input.dataset.metric;
        if (!field || !metric) return;
        const rawValue = parseFloat(input.value);
        const value = clampToRange(isNaN(rawValue) ? 0 : rawValue);
        if (!updated[field]) {
            updated[field] = { ...getFieldWeights(field) };
        }
        updated[field][metric] = value;
    });
    Object.entries(updated).forEach(([field, config]) => {
        const metricSum = ['completeness', 'correctness', 'uniqueness'].reduce((sum, key) => sum + (config[key] ?? 0), 0);
        if (metricSum > 0) {
            ['completeness', 'correctness', 'uniqueness'].forEach(key => {
                config[key] = clampToRange((config[key] ?? 0) / metricSum);
            });
        } else {
            ['completeness', 'correctness', 'uniqueness'].forEach(key => {
                config[key] = 1 / 3;
            });
        }
    });
    let importanceSum = 0;
    Object.values(updated).forEach(config => {
        config.importance = clampToRange(config.importance ?? 0);
        importanceSum += config.importance;
    });
    if (importanceSum > 0) {
        Object.values(updated).forEach(config => {
            config.importance = clampToRange(config.importance / importanceSum);
        });
    } else if (Object.keys(updated).length > 0) {
        const equalImportance = 1 / Object.keys(updated).length;
        Object.values(updated).forEach(config => {
            config.importance = clampToRange(equalImportance);
        });
    }
    currentWeights.perField = {
        ...currentWeights.perField,
        ...updated
    };
    currentWeightedSummary = computeWeightedSummary(currentAnalysis);
    renderWeightedTable();
    if (currentWeights.tableName) {
        displayAnalysisResults(currentAnalysis, currentWeights.tableName);
        updateDashboardOverview(currentAnalysis, currentWeights.tableName);
    }
    showToast('Weights updated successfully', 'success');
}

function getFieldWeights(fieldName) {
    if (currentWeights && currentWeights.perField && currentWeights.perField[fieldName]) {
        return currentWeights.perField[fieldName];
    }
    return {
        completeness: 1 / 3,
        correctness: 1 / 3,
        uniqueness: 1 / 3,
        importance: currentAnalysis && currentAnalysis.field_analyses ? (1 / currentAnalysis.field_analyses.length) : 0
    };
}

function clampToRange(value, min = 0, max = 1) {
    const numeric = isNaN(value) ? min : value;
    if (numeric < min) return min;
    if (numeric > max) return max;
    return numeric;
}

function gradeFromScore(score) {
    if (score >= 85) return 'A';
    if (score >= 70) return 'B';
    if (score >= 55) return 'C';
    return 'D';
}

function computeWeightedSummary(analysis) {
    if (!analysis || !Array.isArray(analysis.field_analyses) || !currentWeights) {
        return null;
    }
    const fieldSummaries = [];
    const fieldMap = {};
    let totalImportance = 0;
    let completenessTotal = 0;
    let correctnessTotal = 0;
    let uniquenessTotal = 0;
    let overallTotal = 0;
    analysis.field_analyses.forEach(field => {
        const weights = getFieldWeights(field.field_name);
        const completenessScore = field.completeness_score || 0;
        const correctnessScore = field.correctness_score || 0;
        const uniquenessScore = field.uniqueness_score || 0;
        const weightedScore = (completenessScore * weights.completeness) +
            (correctnessScore * weights.correctness) +
            (uniquenessScore * weights.uniqueness);
        const summary = {
            field_name: field.field_name,
            data_type: field.data_type,
            completeness_score: completenessScore,
            correctness_score: correctnessScore,
            uniqueness_score: uniquenessScore,
            weighted_score: weightedScore,
            importance: weights.importance,
            quality_grade: gradeFromScore(weightedScore)
        };
        fieldSummaries.push(summary);
        fieldMap[field.field_name] = summary;
        totalImportance += weights.importance;
        completenessTotal += completenessScore * weights.importance;
        correctnessTotal += correctnessScore * weights.importance;
        uniquenessTotal += uniquenessScore * weights.importance;
        overallTotal += weightedScore * weights.importance;
    });
    if (totalImportance === 0) {
        return {
            fields: fieldSummaries,
            fieldMap,
            tableScores: {
                overall_score: 0,
                completeness_score: 0,
                correctness_score: 0,
                uniqueness_score: 0,
                quality_grade: 'D'
            }
        };
    }
    const overallScore = overallTotal / totalImportance;
    return {
        fields: fieldSummaries,
        fieldMap,
        tableScores: {
            overall_score: overallScore,
            completeness_score: completenessTotal / totalImportance,
            correctness_score: correctnessTotal / totalImportance,
            uniqueness_score: uniquenessTotal / totalImportance,
            quality_grade: gradeFromScore(overallScore)
        }
    };
}

async function analyzeTable(tableName) {
    showLoading(true);
    
    try {
        const response = await fetch(`${API_BASE}/analyze/table/${tableName}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                generate_insights: true  // Always generate insights
            })
        });
        
        const data = await response.json();
        console.log('Analysis Response:', data);  // Debug log
        
        if (data.success) {
            currentAnalysis = data.analysis;
            initializeWeightConfig(currentAnalysis, tableName);
            renderWeightedTable();
            
            // Switch to analysis page FIRST before displaying results
            showPage('analysis');
            document.querySelectorAll('.nav-link').forEach(link => {
                link.classList.remove('active');
                if (link.dataset.page === 'analysis') {
                    link.classList.add('active');
                }
            });
            
            // Now display the results after page has changed
            displayAnalysisResults(data.analysis, tableName);
            
            // Update dashboard overview with current analysis
            updateDashboardOverview(data.analysis, tableName);
            
            showToast('✓ Analysis completed successfully', 'success');
            
            // Display AI insights if available
            if (data.analysis.ai_insights) {
                console.log('AI Insights:', data.analysis.ai_insights);  // Debug log
                if (data.analysis.ai_insights.success) {
                    displayAIInsights(data.analysis.ai_insights, tableName);
                    setTimeout(() => {
                        showToast('✓ AI Insights generated! Review and download the PDF report.', 'success');
                    }, 500);
                } else {
                    console.warn('AI Insights generation failed:', data.analysis.ai_insights.error);
                    showToast('Analysis complete. AI insights generation encountered an issue.', 'info');
                }
            } else {
                console.warn('No AI insights in response');
                showToast('Analysis complete. AI insights were not generated.', 'info');
            }
        } else {
            showToast(`Error: ${data.error}`, 'error');
        }
    } catch (error) {
        console.error('Error analyzing table:', error);
        showToast('Failed to analyze table', 'error');
    } finally {
        showLoading(false);
    }
}

async function analyzeCSV() {
    const fileInput = document.getElementById('csvFile');
    const file = fileInput.files[0];
    
    if (!file) {
        showToast('Please select a CSV file', 'error');
        return;
    }
    
    showLoading(true);
    
    const formData = new FormData();
    formData.append('file', file);
    formData.append('generate_insights', document.getElementById('generateInsights').checked);
    
    try {
        const response = await fetch(`${API_BASE}/analyze/csv`, {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        if (data.success) {
            currentAnalysis = data.analysis;
            initializeWeightConfig(currentAnalysis, file.name);
            renderWeightedTable();
            displayAnalysisResults(data.analysis, file.name);
            showToast('CSV analysis completed successfully', 'success');
            
            // Update sub-domain dropdown with detected domain from LLM
            if (data.analysis.detected_domain) {
                updateSubDomainFromAnalysis(data.analysis.detected_domain, file.name);
            }
            
            // Store issues for dynamic rules generation
            if (data.analysis.issues) {
                window.currentIssues = data.analysis.issues;
                window.currentFieldAnalyses = data.analysis.field_analyses;
            }
            
            // Display AI insights if available
            if (data.analysis.ai_insights && data.analysis.ai_insights.success) {
                displayAIInsights(data.analysis.ai_insights, file.name);
                setTimeout(() => {
                    showToast('✓ AI Insights generated! Review and download the PDF report.', 'success');
                }, 500);
            }
        } else {
            showToast(`Error: ${data.error}`, 'error');
        }
    } catch (error) {
        console.error('Error analyzing CSV:', error);
        showToast('Failed to analyze CSV file', 'error');
    } finally {
        showLoading(false);
    }
}

function displayAnalysisResults(analysis, name) {
    // Hide the empty state and show results
    const noAnalysisMessage = document.getElementById('noAnalysisMessage');
    const analysisResults = document.getElementById('analysisResults');
    
    if (noAnalysisMessage) {
        noAnalysisMessage.style.display = 'none';
    }
    if (analysisResults) {
        analysisResults.style.display = 'block';
    }
    
    // Set title
    const titleElement = document.getElementById('analysisTitle');
    if (titleElement) {
        titleElement.textContent = `Analysis: ${name}`;
    }

    currentWeightedSummary = computeWeightedSummary(analysis);
    const tableScores = currentWeightedSummary ? currentWeightedSummary.tableScores : analysis.table_scores;
    
    // Set overall score badge
    const overallScore = tableScores.overall_score;
    const scoreGrade = tableScores.quality_grade;
    const scoreBadge = document.getElementById('overallScore');
    if (scoreBadge) {
        scoreBadge.textContent = `${scoreGrade} (${overallScore.toFixed(1)}%)`;
        scoreBadge.className = `score-badge ${scoreGrade.toLowerCase()}`;
    }
    
    // Update score cards
    updateScoreCard('completeness', tableScores.completeness_score);
    updateScoreCard('correctness', tableScores.correctness_score);
    updateScoreCard('uniqueness', tableScores.uniqueness_score);
    updateScoreCard('consistency', analysis.table_scores.consistency_score);
    
    // Display field analysis
    displayFieldAnalysis(analysis.field_analyses);
    
    // Display issues
    displayIssues(analysis.issues);
    
    // Auto-generate DQ Rules from detected issues
    if (analysis.issues && analysis.issues.length > 0) {
        console.log('Auto-generating DQ Rules from', analysis.issues.length, 'detected issues');
        generateDynamicRules(analysis.issues, analysis.field_analyses);
    }
}

function updateDataQualityOverview(data) {
    document.getElementById('tableNameValue').textContent = data.tableName; 
    document.getElementById('totalRecords').textContent = data.totalRecords;
    document.getElementById('totalTables').textContent = data.totalTables;
    document.getElementById('avgQuality').textContent = `${data.avgQuality}%`;
    document.getElementById('totalIssues').textContent = data.totalIssues;
}

// Example usage: Fetch data and update the dashboard
fetch('/api/data-quality-overview')
    .then(response => response.json())
    .then(data => {
        updateDataQualityOverview(data);
    })
    .catch(error => console.error('Error fetching data quality overview:', error));

function updateScoreCard(type, score) {
    document.getElementById(`${type}Score`).textContent = `${score.toFixed(1)}%`;
    const fill = document.getElementById(`${type}Fill`);
    fill.style.width = `${score}%`;
    
    // Color based on score
    if (score >= 80) {
        fill.style.background = 'linear-gradient(90deg, #10b981 0%, #059669 100%)';
    } else if (score >= 60) {
        fill.style.background = 'linear-gradient(90deg, #3b82f6 0%, #2563eb 100%)';
    } else if (score >= 40) {
        fill.style.background = 'linear-gradient(90deg, #f59e0b 0%, #d97706 100%)';
    } else {
        fill.style.background = 'linear-gradient(90deg, #ef4444 0%, #dc2626 100%)';
    }
}

function displayFieldAnalysis(fieldAnalyses) {
    const container = document.getElementById('fieldAnalysisTable');
    if (!container || !fieldAnalyses || fieldAnalyses.length === 0) {
        if (container) container.innerHTML = '<p style="color: #64748b; text-align: center; padding: 2rem;">No field data available</p>';
        return;
    }
    
    let html = `
    <div style="overflow-x: auto; border: 1px solid #e2e8f0; border-radius: 0.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <table style="width: 100%; border-collapse: collapse; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            <thead>
                <tr style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: white;">
                    <th style="padding: 1rem; text-align: left; font-weight: 700; border-right: 1px solid #7c7f95;">Field Name</th>
                    <th style="padding: 1rem; text-align: left; font-weight: 700; border-right: 1px solid #7c7f95;">Data Type</th>
                    <th style="padding: 1rem; text-align: center; font-weight: 700; border-right: 1px solid #7c7f95; font-size: 0.9rem;">Completeness<br><span style="font-size: 0.85rem; font-weight: 600;">Score & Weight</span></th>
                    <th style="padding: 1rem; text-align: center; font-weight: 700; border-right: 1px solid #7c7f95; font-size: 0.9rem;">Correctness<br><span style="font-size: 0.85rem; font-weight: 600;">Score & Weight</span></th>
                    <th style="padding: 1rem; text-align: center; font-weight: 700; border-right: 1px solid #7c7f95; font-size: 0.9rem;">Uniqueness<br><span style="font-size: 0.85rem; font-weight: 600;">Score & Weight</span></th>
                    <th style="padding: 1rem; text-align: center; font-weight: 700; border-right: 1px solid #7c7f95;">Weighted Score</th>
                    <th style="padding: 1rem; text-align: center; font-weight: 700; border-right: 1px solid #7c7f95;">Column Weight</th>
                    <th style="padding: 1rem; text-align: center; font-weight: 700;">Grade</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    fieldAnalyses.forEach((field, index) => {
        const isEvenRow = index % 2 === 0;
        const rowBg = isEvenRow ? '#ffffff' : '#f8fafc';
        const hoverBg = '#f1f5f9';
        const weights = getFieldWeights(field.field_name);
        const weightedInfo = currentWeightedSummary && currentWeightedSummary.fieldMap ? currentWeightedSummary.fieldMap[field.field_name] : null;
        const weightedScore = weightedInfo ? weightedInfo.weighted_score : field.overall_score;
        const gradeValue = weightedInfo ? weightedInfo.quality_grade : (field.quality_grade || gradeFromScore(field.overall_score));
        
        const getGradeStyle = (grade) => {
            const colors = {
                'A': { bg: '#dcfce7', color: '#166534', border: '#bbf7d0' },
                'B': { bg: '#dbeafe', color: '#1e40af', border: '#bfdbfe' },
                'C': { bg: '#fef3c7', color: '#92400e', border: '#fde68a' },
                'D': { bg: '#fee2e2', color: '#991b1b', border: '#fecaca' }
            };
            return colors[grade] || colors['D'];
        };
        
        const gradeStyle = getGradeStyle(gradeValue);
        
        html += `
                <tr style="background: ${rowBg}; border-bottom: 1px solid #e2e8f0; transition: background 0.2s;" onmouseover="this.style.background='${hoverBg}'" onmouseout="this.style.background='${rowBg}'">
                    <td style="padding: 1rem; border-right: 1px solid #e2e8f0; font-weight: 600; color: #1e293b;">${field.field_name}</td>
                    <td style="padding: 1rem; border-right: 1px solid #e2e8f0; color: #64748b; font-size: 0.875rem;">${field.data_type}</td>
                    <td style="padding: 1rem; border-right: 1px solid #e2e8f0; text-align: center;">
                        <span style="background: #ecfdf5; color: #065f46; padding: 0.375rem 0.75rem; border-radius: 0.375rem; font-weight: 600; font-size: 0.875rem; display: inline-block;">${field.completeness_score.toFixed(1)}%</span>
                        <div style="margin-top: 0.35rem; font-size: 0.75rem; color: #0f766e;">Weight: ${(weights.completeness * 100).toFixed(0)}%</div>
                    </td>
                    <td style="padding: 1rem; border-right: 1px solid #e2e8f0; text-align: center;">
                        <span style="background: #eff6ff; color: #0c4a6e; padding: 0.375rem 0.75rem; border-radius: 0.375rem; font-weight: 600; font-size: 0.875rem; display: inline-block;">${field.correctness_score.toFixed(1)}%</span>
                        <div style="margin-top: 0.35rem; font-size: 0.75rem; color: #0c4a6e;">Weight: ${(weights.correctness * 100).toFixed(0)}%</div>
                    </td>
                    <td style="padding: 1rem; border-right: 1px solid #e2e8f0; text-align: center;">
                        <span style="background: #fef3c7; color: #92400e; padding: 0.375rem 0.75rem; border-radius: 0.375rem; font-weight: 600; font-size: 0.875rem; display: inline-block;">${field.uniqueness_score.toFixed(1)}%</span>
                        <div style="margin-top: 0.35rem; font-size: 0.75rem; color: #9a3412;">Weight: ${(weights.uniqueness * 100).toFixed(0)}%</div>
                    </td>
                    <td style="padding: 1rem; border-right: 1px solid #e2e8f0; text-align: center; font-weight: 700; color: #1e293b;">${weightedScore.toFixed(1)}%</td>
                    <td style="padding: 1rem; border-right: 1px solid #e2e8f0; text-align: center; color: #334155; font-weight: 600;">${(weights.importance * 100).toFixed(0)}%</td>
                    <td style="padding: 1rem; text-align: center;">
                        <span style="background: ${gradeStyle.bg}; color: ${gradeStyle.color}; padding: 0.5rem 0.875rem; border-radius: 0.375rem; font-weight: 700; font-size: 0.875rem; border: 1px solid ${gradeStyle.border}; display: inline-block;">${gradeValue}</span>
                    </td>
                </tr>
        `;
    });
    
    html += `
            </tbody>
        </table>
    </div>
    `;
    
    container.innerHTML = html;
}

function displayIssues(issues) {
    const container = document.getElementById('issuesList');
    if (!container) return;
    
    if (!issues || issues.length === 0) {
        container.innerHTML = '<div style="background: #ecfdf5; border: 1px solid #d1fae5; border-radius: 0.5rem; padding: 1.5rem; text-align: center;"><i class="fas fa-check-circle" style="color: #10b981; font-size: 1.5rem; margin-bottom: 0.5rem;"></i><p style="color: #065f46; font-weight: 600; margin-top: 0.5rem;">✓ No major issues detected - Data quality is excellent!</p></div>';
        return;
    }
    
    let html = `
    <div style="overflow-x: auto; border: 1px solid #fee2e2; border-radius: 0.5rem; background: #ffe8e8;">
        <table style="width: 100%; border-collapse: collapse; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            <thead>
                <tr style="background: #ef4444; color: white;">
                    <th style="padding: 1rem; text-align: left; font-weight: 700; border-right: 1px solid #dc2626;">Issue Type</th>
                    <th style="padding: 1rem; text-align: center; font-weight: 700; border-right: 1px solid #dc2626; width: 120px;">Severity</th>
                    <th style="padding: 1rem; text-align: left; font-weight: 700; border-right: 1px solid #dc2626;">Description</th>
                    <th style="padding: 1rem; text-align: center; font-weight: 700; width: 100px;">Field</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    issues.forEach((issue, index) => {
        const severity = (issue.severity || 'medium').toLowerCase();
        const severityColors = {
            'critical': { bg: '#fee2e2', text: '#991b1b', badge: '#fecaca' },
            'high': { bg: '#fef3c7', text: '#92400e', badge: '#fde68a' },
            'medium': { bg: '#e0f2fe', text: '#0c4a6e', badge: '#bae6fd' },
            'low': { bg: '#f0fdf4', text: '#166534', badge: '#dcfce7' }
        };
        const colors = severityColors[severity] || severityColors['medium'];
        const rowBg = index % 2 === 0 ? '#ffffff' : '#fef5f5';
        
        html += `
                <tr style="background: ${rowBg}; border-bottom: 1px solid #fee2e2;">
                    <td style="padding: 1rem; border-right: 1px solid #fee2e2; font-weight: 600; color: #991b1b;">${issue.type || 'Unknown'}</td>
                    <td style="padding: 1rem; border-right: 1px solid #fee2e2; text-align: center;">
                        <span style="background: ${colors.badge}; color: ${colors.text}; padding: 0.375rem 0.75rem; border-radius: 0.375rem; font-weight: 700; font-size: 0.75rem; text-transform: uppercase;">${severity}</span>
                    </td>
                    <td style="padding: 1rem; border-right: 1px solid #fee2e2; color: #1e293b;">${issue.description || 'No description'}</td>
                    <td style="padding: 1rem; text-align: center; color: #64748b; font-size: 0.875rem;">${issue.field || '-'}</td>
                </tr>
        `;
    });
    
    html += `
            </tbody>
        </table>
    </div>
    `;
    
    container.innerHTML = html;
}

function formatAIResponse(rawResponse) {
    /**
     * Format AI response with proper paragraph spacing, line breaks, and table detection
     */
    if (!rawResponse) return '';
    
    // Split by double newlines to identify paragraphs
    let paragraphs = rawResponse.split(/\n\s*\n/);
    let html = '';
    
    paragraphs.forEach((para, index) => {
        para = para.trim();
        if (!para) return;
        
        // Check if this paragraph contains a table (lines with | separators)
        if (isTableContent(para)) {
            html += formatAsTable(para);
        } else {
            // Regular paragraph with proper line breaks
            const lines = para.split('\n');
            let paraHtml = '<p style="margin: 0 0 1rem 0;">';
            
            lines.forEach((line, lineIdx) => {
                line = line.trim();
                if (line) {
                    // Check if line is a numbered/bulleted item
                    if (/^\d+\.|^-|^\*|^•/.test(line)) {
                        paraHtml = '<ul style="margin: 0 0 1rem 0; padding-left: 1.5rem;">';
                        paraHtml += `<li style="margin-bottom: 0.5rem;">${escapeHtml(line.replace(/^\d+\.|^-|^\*|^•\s*/, ''))}</li>`;
                        // Add remaining bullet points
                        for (let i = lineIdx + 1; i < lines.length; i++) {
                            const nextLine = lines[i].trim();
                            if (/^\d+\.|^-|^\*|^•/.test(nextLine)) {
                                paraHtml += `<li style="margin-bottom: 0.5rem;">${escapeHtml(nextLine.replace(/^\d+\.|^-|^\*|^•\s*/, ''))}</li>`;
                            } else if (nextLine) {
                                break;
                            }
                        }
                        paraHtml += '</ul>';
                        html += paraHtml;
                        return;
                    }
                    paraHtml += escapeHtml(line);
                    if (lineIdx < lines.length - 1) {
                        paraHtml += '<br style="line-height: 1.6;">';
                    }
                }
            });
            paraHtml += '</p>';
            html += paraHtml;
        }
    });
    
    return html;
}

function isTableContent(text) {
    /**
     * Check if text contains table-like structure (multiple lines with | separators)
     */
    const lines = text.split('\n');
    let tableLineCount = 0;
    
    for (let line of lines) {
        if (line.includes('|') && line.trim().split('|').length >= 2) {
            tableLineCount++;
        }
    }
    
    // Consider it a table if at least 2 lines have pipe separators
    return tableLineCount >= 2;
}

function formatAsTable(tableText) {
    /**
     * Format table content in proper HTML table format
     */
    const lines = tableText.split('\n').filter(line => line.trim());
    if (lines.length < 2) return `<p>${escapeHtml(tableText)}</p>`;
    
    let html = '<div style="overflow-x: auto; margin: 0 0 1rem 0; border: 1px solid #e2e8f0; border-radius: 0.5rem;">';
    html += '<table style="width: 100%; border-collapse: collapse; font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif;">';
    
    let isHeaderRow = true;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Skip separator lines (lines with only dashes and pipes)
        if (/^\|?[-\s|]+\|?$/.test(line)) {
            isHeaderRow = false;
            continue;
        }
        
        // Skip empty lines
        if (!line || line === '|') continue;
        
        // Parse cells from line
        const cells = line.split('|').map(cell => cell.trim()).filter(cell => cell);
        
        if (cells.length === 0) continue;
        
        // Create table row
        const tag = isHeaderRow ? 'th' : 'td';
        const bgColor = isHeaderRow ? 'background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: white;' : 
                       (i % 2 === 1 ? 'background: #f8fafc;' : 'background: white;');
        const borderStyle = 'border-bottom: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0;';
        const paddingStyle = 'padding: 0.75rem 1rem;';
        const textAlignStyle = tag === 'th' ? 'text-align: left; font-weight: 700;' : 'text-align: left;';
        
        html += `<tr>`;
        
        cells.forEach((cell, idx) => {
            const isLastCell = idx === cells.length - 1;
            const borderRight = isLastCell ? '' : borderStyle.split(';')[1] + ';';
            html += `<${tag} style="${bgColor} ${paddingStyle} ${textAlignStyle} ${borderRight}">${escapeHtml(cell)}</${tag}>`;
        });
        
        html += `</tr>`;
        isHeaderRow = false;
    }
    
    html += '</table></div>';
    return html;
}

function escapeHtml(text) {
    /**
     * Escape HTML special characters
     */
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, char => map[char]);
}

function displayAIInsights(insights, entityName) {
    const container = document.getElementById('mergedInsights');
    if (!container) return;
    
    const aiInsightsSection = document.getElementById('aiInsightsSection');
    if (aiInsightsSection) {
        aiInsightsSection.style.display = 'block';
    }
    
    // Handle cases where insights might be null or missing
    if (!insights) {
        container.innerHTML = '<p style="color: #64748b;">No AI insights available</p>';
        return;
    }
    
    let html = '<div style="border: 1px solid #dbeafe; border-radius: 0.5rem; background: #f0f9ff; padding: 1.5rem;">';
    
    // Main insights text - with proper formatting
    if (insights.raw_response) {
        const formattedResponse = formatAIResponse(insights.raw_response);
        html += `
        <div style="background: white; padding: 1.5rem; border-radius: 0.5rem; border-left: 4px solid #3b82f6; margin-bottom: 1.5rem; line-height: 1.8;">
            <h5 style="color: #1e40af; margin-top: 0; margin-bottom: 1rem; font-size: 1rem;">📊 AI Analysis Summary</h5>
            <div style="color: #1e293b; line-height: 1.8; font-size: 0.95rem;">${formattedResponse}</div>
        </div>
        `;
    }
    
    // Recommendations list
    if (insights.insights && Array.isArray(insights.insights.recommendations) && insights.insights.recommendations.length > 0) {
        html += `
        <div style="background: white; padding: 1.5rem; border-radius: 0.5rem; margin-bottom: 1.5rem; border-left: 4px solid #10b981;">
            <h5 style="color: #166534; margin-top: 0; margin-bottom: 1rem; font-size: 1rem;">✓ Key Recommendations</h5>
            <ul style="list-style: none; padding: 0; margin: 0;">
        `;
        insights.insights.recommendations.forEach((rec, idx) => {
            html += `
                <li style="margin-bottom: 0.75rem; padding-left: 1.5rem; position: relative; color: #1e293b;">
                    <span style="position: absolute; left: 0; color: #10b981; font-weight: bold;">✓</span>
                    ${rec}
                </li>
            `;
        });
        html += `</ul></div>`;
    }
    
    // Confidence score
    if (insights.confidence_score) {
        const confidence = (insights.confidence_score * 100).toFixed(0);
        const confColor = confidence >= 80 ? '#10b981' : confidence >= 60 ? '#3b82f6' : '#f59e0b';
        html += `
        <div style="background: white; padding: 1.5rem; border-radius: 0.5rem; border: 2px solid ${confColor}; margin-bottom: 1.5rem;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
                <strong style="color: #1e293b;">🎯 Confidence Score</strong>
                <div style="font-size: 1.5rem; font-weight: bold; color: ${confColor};">${confidence}%</div>
            </div>
            <div style="width: 100%; height: 8px; background: #e2e8f0; border-radius: 4px; margin-top: 0.75rem; overflow: hidden;">
                <div style="height: 100%; width: ${confidence}%; background: ${confColor}; transition: width 0.3s;"></div>
            </div>
        </div>
        `;
    }
    
    // Quality check warning
    if (insights.quality_check && !insights.quality_check.passed) {
        html += `
        <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 0.5rem; padding: 1rem; color: #856404;">
            <strong>⚠️ Quality Alert:</strong> ${insights.quality_check.message}
        </div>
        `;
    }
    
    html += '</div>';
    
    container.innerHTML = html;
    
    // Show download button
    const downloadBtn = document.getElementById('downloadPdfBtn');
    if (downloadBtn) {
        downloadBtn.style.display = 'inline-flex';
    }
}

function approveAnalysis() {
    if (!currentAnalysis) {
        showToast('No analysis available to approve', 'error');
        return;
    }
    // Show download button
    const downloadBtn = document.getElementById('downloadPdfBtn');
    if (downloadBtn) {
        downloadBtn.style.display = 'inline-flex';
    }
    showToast('✓ Analysis approved successfully. Download button enabled!', 'success');
}

function rejectAnalysis() {
    console.log('>>> rejectAnalysis() called');
    if (!currentAnalysis) {
        showToast('No analysis available to reject', 'error');
        return;
    }
    
    // Reset to manual domain selection mode
    console.log('>>> Calling resetToManualDomainSelection from rejectAnalysis');
    resetToManualDomainSelection();
    
    showToast('✗ Analysis rejected - domain reset to manual selection', 'warning');
    // Reset analysis view
    currentAnalysis = null;
    document.getElementById('analysisResults').style.display = 'none';
    document.getElementById('noAnalysisMessage').style.display = 'block';
}

async function downloadAnalysisPDF() {
    if (!currentAnalysis) {
        showToast('No analysis available to download', 'error');
        return;
    }
    
    showLoading(true);
    try {
        const response = await fetch(`${API_BASE}/export/analysis-pdf`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                analysis: currentAnalysis,
                entity_name: document.getElementById('analysisTitle').textContent
            })
        });
        
        if (!response.ok) {
            throw new Error('Failed to generate PDF');
        }
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `analysis_${new Date().getTime()}.pdf`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        
        showToast('✓ PDF downloaded successfully', 'success');
    } catch (error) {
        console.error('Error downloading PDF:', error);
        showToast('Failed to download PDF', 'error');
    } finally {
        showLoading(false);
    }
}

// Reset domain selection to manual/database mode (fallback)
function resetToManualDomainSelection() {
    console.log('=== RESETTING TO MANUAL DOMAIN SELECTION ===');
    
    // Clear detected domain
    detectedDomain = null;
    window.detectedDomain = null;
    
    // Clear current analysis data
    currentAnalysis = null;
    window.currentIssues = null;
    window.currentFieldAnalyses = null;
    
    // Clear generated rules
    generatedRules = [];
    
    // Hide detected domain banner if exists
    const domainBanner = document.getElementById('detectedDomainBanner');
    if (domainBanner) {
        domainBanner.style.display = 'none';
        console.log('Hidden domain banner');
    }
    
    // Reset the dropdown styling and VALUE
    const select = document.getElementById('subDomainSelect');
    if (select) {
        select.value = '';  // Reset to "Select Sub-domain" option
        select.style.fontWeight = 'normal';
        select.style.color = '#374151';
        select.style.background = 'white';
        console.log('Reset dropdown value and styling');
    }
    
    // Reset source indicator
    const sourceSpan = document.getElementById('domainSource');
    if (sourceSpan) {
        sourceSpan.innerHTML = `<i class="fas fa-database"></i> Source: Database`;
        sourceSpan.style.background = '#f1f5f9';
        sourceSpan.style.color = '#64748b';
        sourceSpan.style.fontWeight = 'normal';
        console.log('Reset source indicator');
    }
    
    // Reset Dashboard Stats to 0
    const totalRecords = document.getElementById('totalRecords');
    const totalTables = document.getElementById('totalTables');
    const avgQuality = document.getElementById('avgQuality');
    const totalIssues = document.getElementById('totalIssues');
    
    if (totalRecords) totalRecords.textContent = '0';
    if (totalTables) totalTables.textContent = '0';
    if (avgQuality) avgQuality.textContent = '0%';
    if (totalIssues) totalIssues.textContent = '0';
    
    console.log('Reset dashboard stats to 0');
    
    // Reset analysis view
    const analysisResults = document.getElementById('analysisResults');
    const noAnalysisMessage = document.getElementById('noAnalysisMessage');
    if (analysisResults) analysisResults.style.display = 'none';
    if (noAnalysisMessage) noAnalysisMessage.style.display = 'block';
    
    // Hide AI summary section
    const aiRulesSummary = document.getElementById('aiRulesSummary');
    if (aiRulesSummary) aiRulesSummary.style.display = 'none';
    
    // Clear DQ Rules - show empty state
    const rulesGrid = document.getElementById('rulesGrid');
    if (rulesGrid) {
        rulesGrid.innerHTML = `
            <div id="noRulesMessage" style="grid-column: 1/-1; text-align: center; padding: 3rem; color: #64748b;">
                <i class="fas fa-clipboard-list" style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.5;"></i>
                <h4>No Data Selected</h4>
                <p>Upload a CSV file or select data from the database to generate DQ rules based on detected issues.</p>
            </div>`;
        console.log('Cleared DQ Rules');
    }
    
    // Reload domains from database (manual selection mode)
    loadDomainsFromDatabase();
    
    console.log('=== RESET COMPLETE ===');
}

async function reviewInsight(approved) {
    console.log('>>> reviewInsight() called with approved:', approved);
    if (!approved) {
        // Rejected - reset to manual domain selection
        console.log('>>> Rejected - calling resetToManualDomainSelection');
        resetToManualDomainSelection();
        showToast('Insight rejected - domain reset to manual', 'warning');
    } else {
        showToast('Insight approved', 'success');
    }
}

async function initializeDatabase() {
    console.log('>>> initializeDatabase() called');
    if (!confirm('This will reset the database and generate new sample data. Continue?')) {
        return;
    }
    
    showLoading(true);
    
    try {
        const response = await fetch('/admin/init-db', {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Reset to manual domain selection mode and stats FIRST
            console.log('>>> Calling resetToManualDomainSelection after DB init');
            resetToManualDomainSelection();
            
            showToast('Database initialized - all stats reset to 0', 'success');
        } else {
            showToast(`Error: ${data.error}`, 'error');
        }
    } catch (error) {
        console.error('Error initializing database:', error);
        showToast('Failed to initialize database', 'error');
    } finally {
        showLoading(false);
    }
}

// Utility functions
function showLoading(show) {
    const overlay = document.getElementById('loadingOverlay');
    if (show) {
        overlay.classList.add('active');
    } else {
        overlay.classList.remove('active');
    }
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type} active`;
    
    setTimeout(() => {
        toast.classList.remove('active');
    }, 3000);
}

// ==================== CSV UPLOAD PAGE FUNCTIONS ====================

// CSV file upload handling for CSV Upload page
if (document.getElementById('csvFileUpload')) {
    document.getElementById('csvFileUpload').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (file) {
            document.getElementById('csvFileName').textContent = `Selected: ${file.name}`;
            document.getElementById('csvAnalyzeBtn').style.display = 'inline-block';
        }
    });
}

function analyzeCSVFile() {
    const fileInput = document.getElementById('csvFileUpload');
    const file = fileInput.files[0];
    
    if (!file) {
        showToast('Please select a CSV file', 'error');
        return;
    }
    
    showLoading(true);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('generate_insights', document.getElementById('csvGenerateInsights').checked);
    
    fetch(`${API_BASE}/analyze/csv`, {
        method: 'POST',
        body: formData
    })
    .then(response => response.json())
    .then(data => {
        showLoading(false);
        if (data.success) {
            currentAnalysis = data.analysis;
            initializeWeightConfig(currentAnalysis, file.name);
            currentWeightedSummary = computeWeightedSummary(currentAnalysis);
            
            // UPDATE SUB-DOMAIN WITH DETECTED DOMAIN FROM LLM
            if (data.analysis.detected_domain) {
                console.log('Detected domain from LLM:', data.analysis.detected_domain);
                updateSubDomainFromAnalysis(data.analysis.detected_domain, file.name);
            }
            
            // Store issues for dynamic rules generation
            if (data.analysis.issues) {
                window.currentIssues = data.analysis.issues;
                window.currentFieldAnalyses = data.analysis.field_analyses;
            }
            
            // Switch to analysis page FIRST before displaying results
            showPage('analysis');
            document.querySelectorAll('.nav-link').forEach(link => {
                link.classList.remove('active');
                if (link.dataset.page === 'analysis') {
                    link.classList.add('active');
                }
            });
            
            // Now display the results after page has changed
            displayAnalysisResults(data.analysis, file.name);
            
            // Update dashboard overview with current analysis
            updateDashboardOverview(data.analysis, file.name);
            
            showToast('✓ CSV analysis completed successfully!', 'success');
            
            // Display AI insights if available
            if (data.analysis.ai_insights && data.analysis.ai_insights.success) {
                displayAIInsights(data.analysis.ai_insights, file.name);
                setTimeout(() => {
                    showToast('✓ AI Insights generated! Review and download the PDF report.', 'success');
                }, 500);
            }
        } else {
            showToast(`Error: ${data.error}`, 'error');
        }
    })
    .catch(error => {
        console.error('Error:', error);
        showToast('Failed to analyze CSV file', 'error');
        showLoading(false);
    });
}

function displayCSVResults(analysis, filename) {
    const container = document.getElementById('csvAnalysisResults');
    container.style.display = 'block';

    const weightedSummary = computeWeightedSummary(analysis);
    const tableScores = weightedSummary ? weightedSummary.tableScores : analysis.table_scores;
    const fieldMap = weightedSummary ? weightedSummary.fieldMap : null;
    const consistencyScore = analysis.table_scores.consistency_score || 0;
    const grade = (tableScores.quality_grade || analysis.table_scores.quality_grade).toLowerCase();

    let html = `
        <div class="results-header">
            <h3>CSV Analysis: ${filename}</h3>
            <div class="score-badge ${grade}">${tableScores.quality_grade} (${tableScores.overall_score.toFixed(1)}%)</div>
        </div>
        
        <div class="score-grid">
            <div class="score-card">
                <div class="score-label">Completeness</div>
                <div class="score-value">${tableScores.completeness_score.toFixed(1)}%</div>
                <div class="score-bar">
                    <div class="score-fill" style="width: ${tableScores.completeness_score}%; background: ${getScoreColor(tableScores.completeness_score)}"></div>
                </div>
            </div>
            <div class="score-card">
                <div class="score-label">Correctness</div>
                <div class="score-value">${tableScores.correctness_score.toFixed(1)}%</div>
                <div class="score-bar">
                    <div class="score-fill" style="width: ${tableScores.correctness_score}%; background: ${getScoreColor(tableScores.correctness_score)}"></div>
                </div>
            </div>
            <div class="score-card">
                <div class="score-label">Uniqueness</div>
                <div class="score-value">${tableScores.uniqueness_score.toFixed(1)}%</div>
                <div class="score-bar">
                    <div class="score-fill" style="width: ${tableScores.uniqueness_score}%; background: ${getScoreColor(tableScores.uniqueness_score)}"></div>
                </div>
            </div>
            <div class="score-card">
                <div class="score-label">Consistency</div>
                <div class="score-value">${consistencyScore.toFixed(1)}%</div>
                <div class="score-bar">
                    <div class="score-fill" style="width: ${consistencyScore}%; background: ${getScoreColor(consistencyScore)}"></div>
                </div>
            </div>
        </div>
        
        <div class="analysis-section">
            <h4>Field-Level Analysis</h4>
            <div class="table-responsive">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Field Name</th>
                            <th>Data Type</th>
                            <th>Completeness</th>
                            <th>Correctness</th>
                            <th>Weighted Score</th>
                            <th>Grade</th>
                        </tr>
                    </thead>
                    <tbody>
    `;

    analysis.field_analyses.forEach(field => {
        const weightedInfo = fieldMap ? fieldMap[field.field_name] : null;
        const weightedScore = weightedInfo ? weightedInfo.weighted_score : field.overall_score;
        const gradeValue = weightedInfo ? weightedInfo.quality_grade : (field.quality_grade || gradeFromScore(field.overall_score));
        html += `
            <tr>
                <td><strong>${field.field_name}</strong></td>
                <td>${field.data_type}</td>
                <td>${field.completeness_score.toFixed(1)}%</td>
                <td>${field.correctness_score.toFixed(1)}%</td>
                <td>${weightedScore.toFixed(1)}%</td>
                <td><span class="badge ${gradeValue.toLowerCase()}">${gradeValue}</span></td>
            </tr>
        `;
    });

    html += `
                    </tbody>
                </table>
            </div>
        </div>
        
        <div class="analysis-section">
            <h4>Detected Issues (${analysis.issues.length})</h4>
            <div id="csvIssuesList">
    `;

    if (analysis.issues.length > 0) {
        analysis.issues.forEach(issue => {
            const severity = issue.severity || 'medium';
            html += `
                <div class="issue-item ${severity}">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                        <strong>${issue.type || 'Issue'}</strong>
                        <span class="badge ${severity}">${severity.toUpperCase()}</span>
                    </div>
                    <p>${issue.description}</p>
                    ${issue.field ? `<p style="font-size: 0.9rem; color: #64748b; margin-top: 0.5rem;">Field: ${issue.field}</p>` : ''}
                </div>
            `;
        });
    } else {
        html += '<p style="color: #10b981;"><i class="fas fa-check-circle"></i> No major issues detected</p>';
    }

    html += `
            </div>
        </div>
    `;

    container.innerHTML = html;
}

// ==================== DQ RULES PAGE FUNCTIONS ====================

function showCreateRuleModal() {
    showToast('Create New Rule feature - Coming soon!', 'info');
    // TODO: Implement create rule modal
}

function editRule(ruleId) {
    showToast(`Editing rule #${ruleId}`, 'info');
    // TODO: Implement edit rule functionality
}

function toggleRule(ruleId) {
    showToast(`Rule #${ruleId} status toggled`, 'success');
    // TODO: Implement toggle rule functionality
}

function getLLMRuleSuggestions() {
    showLoading(true);
    showToast('Generating AI suggestions...', 'info');
    
    // Simulate LLM call
    setTimeout(() => {
        const suggestionsSection = document.getElementById('llmSuggestions');
        suggestionsSection.style.display = 'block';
        
        const suggestionsList = document.getElementById('suggestionsList');
        suggestionsList.innerHTML = `
            <div class="suggestion-card">
                <div class="suggestion-header">
                    <h4>📊 Email Domain Validation</h4>
                    <span class="badge" style="background: var(--primary-color);">AI Suggested</span>
                </div>
                <p>Add validation to check if email domains are from valid/active domains, not disposable email services.</p>
                <div class="rule-details">
                    <span><strong>Type:</strong> Correctness</span>
                    <span><strong>Suggested Weight:</strong> 15%</span>
                </div>
                <div class="rule-actions">
                    <button class="btn btn-success btn-small" onclick="approveSuggestion(1)">
                        <i class="fas fa-check"></i> Approve
                    </button>
                    <button class="btn btn-small" onclick="rejectSuggestion(1)">
                        <i class="fas fa-times"></i> Reject
                    </button>
                </div>
            </div>
            
            <div class="suggestion-card">
                <div class="suggestion-header">
                    <h4>📱 Phone Number Format Standardization</h4>
                    <span class="badge" style="background: var(--primary-color);">AI Suggested</span>
                </div>
                <p>Enforce consistent phone number format (e.g., +91-XXXX-XXXXXX) across all records.</p>
                <div class="rule-details">
                    <span><strong>Type:</strong> Consistency</span>
                    <span><strong>Suggested Weight:</strong> 10%</span>
                </div>
                <div class="rule-actions">
                    <button class="btn btn-success btn-small" onclick="approveSuggestion(2)">
                        <i class="fas fa-check"></i> Approve
                    </button>
                    <button class="btn btn-small" onclick="rejectSuggestion(2)">
                        <i class="fas fa-times"></i> Reject
                    </button>
                </div>
            </div>
            
            <div class="suggestion-card">
                <div class="suggestion-header">
                    <h4>💰 Salary Range Validation</h4>
                    <span class="badge" style="background: var(--primary-color);">AI Suggested</span>
                </div>
                <p>Check if salary values fall within expected ranges for each designation/department.</p>
                <div class="rule-details">
                    <span><strong>Type:</strong> Correctness</span>
                    <span><strong>Suggested Weight:</strong> 20%</span>
                </div>
                <div class="rule-actions">
                    <button class="btn btn-success btn-small" onclick="approveSuggestion(3)">
                        <i class="fas fa-check"></i> Approve
                    </button>
                    <button class="btn btn-small" onclick="rejectSuggestion(3)">
                        <i class="fas fa-times"></i> Reject
                    </button>
                </div>
            </div>
        `;
        
        showLoading(false);
        showToast('AI suggestions generated!', 'success');
    }, 2000);
}

function approveSuggestion(suggestionId) {
    showToast(`Suggestion #${suggestionId} approved and rule created!`, 'success');
    // TODO: Create rule from suggestion
}

function rejectSuggestion(suggestionId) {
    showToast(`Suggestion #${suggestionId} rejected`, 'info');
    // TODO: Remove suggestion from display
}

// Helper function for score colors
function getScoreColor(score) {
    if (score >= 95) return '#10b981'; // Excellent - Green
    if (score >= 80) return '#3b82f6'; // Good - Blue
    if (score >= 60) return '#f59e0b'; // Fair - Orange
    return '#ef4444'; // Poor - Red
}

// ========================================
// Domain & Sub-domain Functions
// ========================================

let domainQualityChart = null;
let currentSubDomain = null;
let currentDomain = null;
let editMode = false;

function switchFilterTab(tab) {
    const domainTab = document.getElementById('domainTab');
    const allTab = document.getElementById('allTab');
    
    // Update active state
    domainTab.classList.toggle('active', tab === 'domain');
    allTab.classList.toggle('active', tab === 'all');
    
    // Update styles
    if (tab === 'domain') {
        domainTab.style.background = 'var(--primary-color)';
        domainTab.style.color = 'white';
        allTab.style.background = 'white';
        allTab.style.color = '#475569';
        allTab.style.border = '1px solid #e2e8f0';
    } else {
        allTab.style.background = 'var(--primary-color)';
        allTab.style.color = 'white';
        domainTab.style.background = 'white';
        domainTab.style.color = '#475569';
        domainTab.style.border = '1px solid #e2e8f0';
    }
    
    // Load appropriate data
    if (tab === 'all') {
        loadAllDomainsData();
    } else {
        loadDomainData();
    }
}

function filterBySubDomain() {
    const select = document.getElementById('subDomainSelect');
    const selectedValue = select.value;
    
    if (selectedValue) {
        showToast(`Filtering by sub-domain: ${select.options[select.selectedIndex].text}`, 'info');
        // Implement filtering logic here
    }
}

function loadDomainQualityChart() {
    fetch('/api/chart/domain-quality')
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                renderDomainChart(data.data);
            }
        })
        .catch(error => {
            console.error('Error loading chart data:', error);
        });
}

function renderDomainChart(chartData) {
    const ctx = document.getElementById('domainQualityChart');
    if (!ctx) return;
    
    // Destroy existing chart
    if (domainQualityChart) {
        domainQualityChart.destroy();
    }
    
    domainQualityChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['HR\n90%', 'Core HR\n90%', 'Payroll\n82%', 'Finance\n80%', 'Accounts\nReceivable\n78%', 'Accounts\nPayable\n64%', 'DQ.80%'],
            datasets: [{
                label: 'Data Quality Score (%)',
                data: [90, 90, 82, 80, 78, 64, 80],
                backgroundColor: [
                    '#3b82f6',
                    '#60a5fa', 
                    '#93c5fd',
                    '#f59e0b',
                    '#fbbf24',
                    '#fcd34d',
                    '#3b82f6'
                ],
                borderColor: '#1e293b',
                borderWidth: 0,
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            aspectRatio: 2.5,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: '#1e293b',
                    padding: 12,
                    titleFont: {
                        size: 14,
                        weight: 'bold'
                    },
                    bodyFont: {
                        size: 13
                    },
                    callbacks: {
                        label: function(context) {
                            return 'DQ Score: ' + context.parsed.y + '%';
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: 100,
                    ticks: {
                        callback: function(value) {
                            return value + '%';
                        },
                        font: {
                            size: 12
                        }
                    },
                    grid: {
                        color: '#e2e8f0'
                    }
                },
                x: {
                    ticks: {
                        font: {
                            size: 11,
                            weight: '600'
                        },
                        color: '#475569'
                    },
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}

function loadDomainData() {
    // Load domain summary data
    fetch('/api/domain/summary')
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                // Update stats based on domain data
                console.log('Domain data loaded:', data.domains);
            }
        })
        .catch(error => {
            console.error('Error loading domain data:', error);
        });
}

function loadAllDomainsData() {
    // Load data for all domains
    showToast('Loading all domains data...', 'info');
}

// ========================================
// Sub-domain AI Insights Functions
// ========================================

function viewSubDomainInsights(subDomain, score) {
    currentSubDomain = subDomain;
    
    // Determine domain based on sub-domain
    if (subDomain === 'Core HR' || subDomain === 'Payroll') {
        currentDomain = 'HR';
    } else {
        currentDomain = 'Finance';
    }
    
    // Navigate to DQ Rules page
    showPage('rules');
    
    // Update nav
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.remove('active');
        if (link.dataset.page === 'rules') {
            link.classList.add('active');
        }
    });
    
    // AI Summary section removed - use Get AI Suggestions button instead
}

async function getSubDomainAISummary(subDomain = null, score = null) {
    // Use provided values or current context
    const targetSubDomain = subDomain || currentSubDomain || 'Core HR';
    const targetScore = score || 90;
    const targetDomain = currentDomain || 'HR';
    
    showLoading(true, 'Generating AI insights...');
    
    try {
        const response = await fetch('/api/subdomain/ai-summary', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                sub_domain: targetSubDomain,
                domain: targetDomain,
                score: targetScore
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Show AI summary section
            const summarySection = document.getElementById('aiSummarySection');
            const summaryDisplay = document.getElementById('summaryDisplay');
            const summaryEditor = document.getElementById('summaryEditor');
            const selectedSubDomainSpan = document.getElementById('selectedSubDomain');
            const aiSummaryScore = document.getElementById('aiSummaryScore');
            
            if (summarySection) {
                summarySection.style.display = 'block';
                selectedSubDomainSpan.textContent = targetSubDomain;
                aiSummaryScore.textContent = `DQ: ${targetScore}%`;
                summaryDisplay.textContent = data.summary;
                summaryEditor.value = data.summary;
                
                // Store current data
                summarySection.dataset.subDomain = targetSubDomain;
                summarySection.dataset.domain = targetDomain;
                summarySection.dataset.score = targetScore;
                
                // Reset to display mode
                editMode = false;
                summaryDisplay.style.display = 'block';
                summaryEditor.style.display = 'none';
                document.getElementById('editToggleBtn').innerHTML = '<i class="fas fa-pen"></i> Edit';
                
                // Scroll to summary
                summarySection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                
                showToast('AI summary generated successfully!', 'success');
            }
        } else {
            showToast('Error: ' + (data.error || 'Failed to generate summary'), 'error');
        }
    } catch (error) {
        console.error('Error generating AI summary:', error);
        showToast('Error generating AI summary', 'error');
    } finally {
        showLoading(false);
    }
}

function toggleEditMode() {
    const summaryDisplay = document.getElementById('summaryDisplay');
    const summaryEditor = document.getElementById('summaryEditor');
    const editToggleBtn = document.getElementById('editToggleBtn');
    
    editMode = !editMode;
    
    if (editMode) {
        summaryDisplay.style.display = 'none';
        summaryEditor.style.display = 'block';
        summaryEditor.value = summaryDisplay.textContent;
        editToggleBtn.innerHTML = '<i class="fas fa-eye"></i> Preview';
        showToast('Edit mode enabled. Modify the summary as needed.', 'info');
    } else {
        summaryDisplay.style.display = 'block';
        summaryEditor.style.display = 'none';
        summaryDisplay.textContent = summaryEditor.value;
        editToggleBtn.innerHTML = '<i class="fas fa-pen"></i> Edit';
    }
}

async function saveAISummary() {
    const summaryEditor = document.getElementById('summaryEditor');
    const summaryDisplay = document.getElementById('summaryDisplay');
    const summarySection = document.getElementById('aiSummarySection');
    
    const subDomain = summarySection.dataset.subDomain;
    const domain = summarySection.dataset.domain;
    const editedSummary = editMode ? summaryEditor.value : summaryDisplay.textContent;
    
    if (!editedSummary.trim()) {
        showToast('Summary cannot be empty', 'error');
        return;
    }
    
    showLoading(true, 'Saving summary...');
    
    try {
        const response = await fetch('/api/subdomain/save-summary', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                sub_domain: subDomain,
                domain: domain,
                summary: editedSummary,
                edited_by: 'User'
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('Summary saved successfully!', 'success');
            
            // Update display
            summaryDisplay.textContent = editedSummary;
            
            // Exit edit mode
            if (editMode) {
                toggleEditMode();
            }
        } else {
            showToast('Error: ' + (data.error || 'Failed to save summary'), 'error');
        }
    } catch (error) {
        console.error('Error saving summary:', error);
        showToast('Error saving summary', 'error');
    } finally {
        showLoading(false);
    }
}

function closeAISummary() {
    const summarySection = document.getElementById('aiSummarySection');
    if (summarySection) {
        summarySection.style.display = 'none';
    }
    
    // Reset edit mode
    if (editMode) {
        toggleEditMode();
    }
}

// ========================================
// Dynamic Domain Detection & Rules
// ========================================

// Update sub-domain dropdown after CSV analysis - IMMEDIATE UPDATE
function updateSubDomainFromAnalysis(domain, tableName) {
    console.log('updateSubDomainFromAnalysis called with domain:', domain, 'tableName:', tableName);
    
    if (!domain) {
        console.error('No domain provided');
        return;
    }
    
    // Store globally
    detectedDomain = domain;
    window.detectedDomain = domain;
    window.detectedFromFile = tableName;
    
    // 1. UPDATE THE ANALYSIS PAGE BANNER (visible immediately)
    const banner = document.getElementById('detectedDomainBanner');
    const domainText = document.getElementById('detectedDomainText');
    const fromFile = document.getElementById('detectedFromFile');
    
    if (banner && domainText) {
        banner.style.display = 'block';
        domainText.textContent = domain;
        if (fromFile) {
            fromFile.textContent = tableName || 'uploaded CSV';
        }
        console.log('Analysis page banner updated with domain:', domain);
    }
    
    // 2. UPDATE THE DASHBOARD DROPDOWN (for when user navigates there)
    const select = document.getElementById('subDomainSelect');
    const sourceSpan = document.getElementById('domainSource');
    
    if (select) {
        // Clear and set new option
        select.innerHTML = '';
        
        // Add detected domain as the ONLY selected option
        const option = document.createElement('option');
        option.value = domain.toLowerCase();
        option.textContent = domain;
        option.selected = true;
        select.appendChild(option);
        
        // Force visual update
        select.style.fontWeight = '700';
        select.style.color = '#1e40af';
        select.style.background = '#dbeafe';
        
        console.log('Dashboard dropdown updated with domain:', domain);
    }
    
    // Update source indicator on dashboard
    if (sourceSpan) {
        sourceSpan.innerHTML = `<i class="fas fa-file-csv"></i> Source: CSV (${tableName || 'Uploaded'})`;
        sourceSpan.style.background = '#dcfce7';
        sourceSpan.style.color = '#166534';
        sourceSpan.style.fontWeight = '600';
    }
    
    showToast(`Domain detected: ${domain}`, 'success');
}

// Load domains from database (fallback when no CSV)
async function loadDomainsFromDatabase() {
    console.log('Loading domains from database...');
    try {
        const response = await fetch(`${API_BASE}/domains/from-database`);
        const data = await response.json();
        
        const select = document.getElementById('subDomainSelect');
        const sourceSpan = document.getElementById('domainSource');
        
        if (!select) {
            console.log('Dropdown not found!');
            return;
        }
        
        // Reset dropdown styling to default
        select.style.fontWeight = 'normal';
        select.style.color = '#374151';
        select.style.background = 'white';
        
        // Clear and populate with default option first
        select.innerHTML = '<option value="">Select Sub-domain</option>';
        
        if (data.success && data.domains && data.domains.length > 0) {
            data.domains.forEach(domain => {
                const option = document.createElement('option');
                option.value = domain.name.toLowerCase();
                option.textContent = domain.name;
                select.appendChild(option);
            });
            console.log(`Loaded ${data.domains.length} domains from database`);
        } else {
            // Add default domains if none from database
            const defaultDomains = ['Finance', 'Healthcare', 'HR', 'Retail', 'Manufacturing'];
            defaultDomains.forEach(d => {
                const option = document.createElement('option');
                option.value = d.toLowerCase();
                option.textContent = d;
                select.appendChild(option);
            });
            console.log('Using default domains');
        }
        
        if (sourceSpan) {
            sourceSpan.innerHTML = `<i class="fas fa-database"></i> Source: Database`;
            sourceSpan.style.background = '#f1f5f9';
            sourceSpan.style.color = '#64748b';
            sourceSpan.style.fontWeight = 'normal';
        }
    } catch (error) {
        console.error('Error loading domains from database:', error);
        // Fallback to default domains
        const select = document.getElementById('subDomainSelect');
        if (select) {
            select.innerHTML = '<option value="">Select Sub-domain</option>';
            const defaultDomains = ['Finance', 'Healthcare', 'HR', 'Retail', 'Manufacturing'];
            defaultDomains.forEach(d => {
                const option = document.createElement('option');
                option.value = d.toLowerCase();
                option.textContent = d;
                select.appendChild(option);
            });
        }
    }
}

// Generate dynamic rules from detected issues
async function generateDynamicRules(issues, fieldAnalyses) {
    try {
        const response = await fetch(`${API_BASE}/generate-rules-from-issues`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ issues, field_analyses: fieldAnalyses })
        });
        
        const data = await response.json();
        
        if (data.success && data.rules) {
            generatedRules = data.rules;
            renderDynamicRules(data.rules);
        }
    } catch (error) {
        console.error('Error generating rules:', error);
    }
}

// Render dynamic rules in DQ Rules page
function renderDynamicRules(rules) {
    const rulesGrid = document.getElementById('rulesGrid');
    if (!rulesGrid) return;
    
    if (!rules || rules.length === 0) {
        rulesGrid.innerHTML = `
            <div id="noRulesMessage" style="grid-column: 1/-1; text-align: center; padding: 3rem; color: #64748b;">
                <i class="fas fa-clipboard-list" style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.5;"></i>
                <h4>No Data Analyzed</h4>
                <p>Upload a CSV file or select data from the database in "AI & Insights" tab to generate DQ rules based on detected issues.</p>
            </div>`;
        return;
    }
    
    let html = '';
    
    // Add summary header
    const highCount = rules.filter(r => r.severity === 'high').length;
    const mediumCount = rules.filter(r => r.severity === 'medium').length;
    const lowCount = rules.filter(r => r.severity === 'low').length;
    
    html += `
    <div style="grid-column: 1/-1; background: linear-gradient(135deg, #1e3a5f 0%, #2d5a87 100%); color: white; padding: 1rem 1.5rem; border-radius: 0.75rem; margin-bottom: 1rem; display: flex; justify-content: space-between; align-items: center;">
        <div>
            <h4 style="margin: 0; font-size: 1rem;"><i class="fas fa-shield-alt"></i> Generated Rules Based on Detected Issues</h4>
            <p style="margin: 0.25rem 0 0 0; font-size: 0.85rem; opacity: 0.9;">${rules.length} rules generated from analysis</p>
        </div>
        <div style="display: flex; gap: 1rem; font-size: 0.8rem;">
            <span style="background: rgba(239,68,68,0.2); padding: 0.25rem 0.75rem; border-radius: 1rem;"><strong>${highCount}</strong> High</span>
            <span style="background: rgba(245,158,11,0.2); padding: 0.25rem 0.75rem; border-radius: 1rem;"><strong>${mediumCount}</strong> Medium</span>
            <span style="background: rgba(16,185,129,0.2); padding: 0.25rem 0.75rem; border-radius: 1rem;"><strong>${lowCount}</strong> Low</span>
        </div>
    </div>`;
    
    rules.forEach(rule => {
        const severityColor = rule.severity === 'high' ? '#ef4444' : 
                             rule.severity === 'medium' ? '#f59e0b' : '#10b981';
        const severityBg = rule.severity === 'high' ? '#fef2f2' : 
                          rule.severity === 'medium' ? '#fffbeb' : '#f0fdf4';
        const typeColor = {
            'Completeness': '#3b82f6',
            'Correctness': '#8b5cf6',
            'Uniqueness': '#ec4899',
            'Consistency': '#06b6d4',
            'Validation': '#64748b'
        }[rule.type] || '#64748b';
        
        // Generate a brief AI-style summary for each rule
        const summaryText = generateRuleSummary(rule);
        
        html += `
        <div class="rule-card" style="border-left: 4px solid ${typeColor}; background: ${severityBg};">
            <div class="rule-header">
                <h4 style="display: flex; align-items: center; gap: 0.5rem;">
                    <i class="fas fa-exclamation-triangle" style="color: ${severityColor};"></i>
                    ${rule.name}
                </h4>
                <span class="badge" style="background: ${severityColor};">${rule.severity}</span>
            </div>
            <p style="color: #475569; margin: 0.5rem 0;">${rule.description}</p>
            <div style="background: white; padding: 0.75rem; border-radius: 0.5rem; margin: 0.75rem 0; border: 1px solid #e2e8f0;">
                <p style="margin: 0; font-size: 0.85rem; color: #64748b;">
                    <i class="fas fa-lightbulb" style="color: #f59e0b; margin-right: 0.5rem;"></i>
                    <strong>Summary:</strong> ${summaryText}
                </p>
            </div>
            <div class="rule-details">
                <span><strong>Field:</strong> ${rule.field}</span>
                <span><strong>Type:</strong> ${rule.type}</span>
                <span><strong>Weight:</strong> ${rule.weight}%</span>
            </div>
            <div class="rule-actions">
                <button class="btn-small btn-primary" onclick="editDynamicRule(${rule.id})">
                    <i class="fas fa-edit"></i> Edit
                </button>
                <button class="btn-small" onclick="toggleDynamicRule(${rule.id})" style="background: ${rule.active ? '#ef4444' : '#10b981'}; color: white;">
                    <i class="fas fa-power-off"></i> ${rule.active ? 'Disable' : 'Enable'}
                </button>
            </div>
        </div>`;
    });
    
    rulesGrid.innerHTML = html;
}

// Generate a brief AI-style summary for a rule
function generateRuleSummary(rule) {
    const summaries = {
        'Completeness': `${rule.field} has missing or incomplete data that needs to be filled to ensure data integrity.`,
        'Correctness': `${rule.field} contains values that don't match expected format or business rules.`,
        'Uniqueness': `${rule.field} has duplicate values that may cause data inconsistency issues.`,
        'Consistency': `${rule.field} shows inconsistent patterns that need standardization.`,
        'Validation': `${rule.field} requires validation to ensure data meets quality standards.`
    };
    
    const severityImpact = {
        'high': 'Immediate attention required - impacts critical business processes.',
        'medium': 'Should be addressed soon - may affect reporting accuracy.',
        'low': 'Can be scheduled for later - minor impact on data quality.'
    };
    
    return summaries[rule.type] || `Review ${rule.field} for data quality issues. ${severityImpact[rule.severity] || ''}`;
}

// Minimal fallback for actionable recommendation - LLM provides better context-aware suggestions
function getActionableRecommendation(issue) {
    const field = issue.field || 'the field';
    const severity = issue.severity || 'medium';
    
    // Only 2-3 generic fallbacks - rely on LLM for detailed recommendations
    if (severity === 'high') {
        return `Review and correct ${field} values from authoritative data source`;
    } else if (severity === 'medium') {
        return `Validate ${field} data against business rules`;
    } else {
        return `Monitor ${field} for data quality improvements`;
    }
}

function editDynamicRule(ruleId) {
    showToast(`Editing rule ${ruleId}`, 'info');
}

function toggleDynamicRule(ruleId) {
    const rule = generatedRules.find(r => r.id === ruleId);
    if (rule) {
        rule.active = !rule.active;
        renderDynamicRules(generatedRules);
        showToast(`Rule ${rule.active ? 'enabled' : 'disabled'}`, 'success');
    }
}

// Get AI Suggestions - generates STRUCTURED summary with Record-Level Assessment and LLM Insights
async function getAISuggestionsForRules() {
    if (!currentAnalysis || !currentAnalysis.issues || currentAnalysis.issues.length === 0) {
        showToast('Run analysis first in AI & Insights tab to generate AI suggestions', 'warning');
        return;
    }
    
    showLoading(true, 'Generating AI-powered analysis...');
    
    try {
        const response = await fetch(`${API_BASE}/generate-detailed-issue-analysis`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                issues: currentAnalysis.issues,
                field_analyses: currentAnalysis.field_analyses || [],
                domain: detectedDomain || window.detectedDomain || 'Data',
                table_scores: currentAnalysis.table_scores || {}
            })
        });
        
        const data = await response.json();
        
        const summaryDiv = document.getElementById('aiRulesSummary');
        const summaryText = document.getElementById('aiRulesSummaryText');
        
        if (summaryDiv && summaryText) {
            summaryDiv.style.display = 'block';
            
            // Calculate Record-Level Assessment from current analysis
            const overallScore = currentAnalysis.table_scores?.overall_score || 0;
            const issues = currentAnalysis.issues || [];
            const criticalCount = issues.filter(i => i.severity === 'high').length;
            const highPriorityCount = issues.filter(i => i.severity === 'medium').length;
            const lowPriorityCount = issues.filter(i => i.severity === 'low').length;
            
            // Determine status
            let status = 'GOOD';
            let statusColor = '#10b981';
            let statusBg = '#dcfce7';
            if (overallScore < 40) {
                status = 'REQUIRES IMMEDIATE ATTENTION';
                statusColor = '#dc2626';
                statusBg = '#fef2f2';
            } else if (overallScore < 60) {
                status = 'NEEDS IMPROVEMENT';
                statusColor = '#f59e0b';
                statusBg = '#fffbeb';
            } else if (overallScore < 80) {
                status = 'ACCEPTABLE';
                statusColor = '#3b82f6';
                statusBg = '#eff6ff';
            }
            
            let html = '';
            
            // Record-Level Assessment Section
            html += `
            <div style="background: linear-gradient(135deg, #1e293b 0%, #334155 100%); color: white; padding: 1.25rem 1.5rem; border-radius: 0.75rem; margin-bottom: 1.5rem;">
                <h3 style="margin: 0 0 1rem 0; font-size: 1.1rem; display: flex; align-items: center; gap: 0.5rem;">
                    <i class="fas fa-clipboard-check"></i> Record-Level Assessment
                </h3>
                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem;">
                    <div style="background: rgba(255,255,255,0.1); padding: 0.75rem; border-radius: 0.5rem;">
                        <p style="margin: 0; font-size: 0.8rem; opacity: 0.8;">Overall Quality Score</p>
                        <p style="margin: 0.25rem 0 0 0; font-size: 1.5rem; font-weight: 700;">${overallScore.toFixed(0)}% <span style="font-size: 0.9rem; font-weight: 400; opacity: 0.8;">(${overallScore < 40 ? 'Poor' : overallScore < 60 ? 'Fair' : overallScore < 80 ? 'Good' : 'Excellent'})</span></p>
                    </div>
                    <div style="background: rgba(255,255,255,0.1); padding: 0.75rem; border-radius: 0.5rem;">
                        <p style="margin: 0; font-size: 0.8rem; opacity: 0.8;">Status</p>
                        <p style="margin: 0.25rem 0 0 0; font-size: 0.95rem; font-weight: 600; color: ${statusColor}; background: ${statusBg}; padding: 0.25rem 0.5rem; border-radius: 0.25rem; display: inline-block;">${status}</p>
                    </div>
                    <div style="background: rgba(239,68,68,0.2); padding: 0.75rem; border-radius: 0.5rem;">
                        <p style="margin: 0; font-size: 0.8rem; opacity: 0.8;">Critical Issues</p>
                        <p style="margin: 0.25rem 0 0 0; font-size: 1.25rem; font-weight: 700; color: #fca5a5;">${criticalCount}</p>
                    </div>
                    <div style="background: rgba(245,158,11,0.2); padding: 0.75rem; border-radius: 0.5rem;">
                        <p style="margin: 0; font-size: 0.8rem; opacity: 0.8;">High Priority Issues</p>
                        <p style="margin: 0.25rem 0 0 0; font-size: 1.25rem; font-weight: 700; color: #fcd34d;">${highPriorityCount}</p>
                    </div>
                </div>
            </div>`;
            
            // LLM-Generated Insights Header
            html += `
            <div style="background: linear-gradient(135deg, #1e3a5f 0%, #2d5a87 100%); color: white; padding: 1rem 1.5rem; border-radius: 0.75rem 0.75rem 0 0; margin-bottom: 0;">
                <h3 style="margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 0.5rem;">
                    <i class="fas fa-robot"></i> LLM-Generated Insights
                </h3>
                <p style="margin: 0.5rem 0 0 0; font-size: 0.85rem; opacity: 0.9;">Domain: ${data.structured_analysis?.domain || detectedDomain || 'Data'} | Generated ${new Date().toLocaleString()}</p>
            </div>
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 0.75rem 0.75rem; padding: 1.25rem; margin-bottom: 1rem;">`;
            
            if (data.success && data.structured_analysis) {
                const analysis = data.structured_analysis;
                
                // Critical Findings Section
                html += `
                <div style="margin-bottom: 1.5rem;">
                    <h4 style="color: #dc2626; font-size: 1rem; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem;">
                        <span style="font-size: 1.2rem;">🔴</span> Critical Findings
                    </h4>`;
                
                if (analysis.critical_findings && analysis.critical_findings.length > 0) {
                    analysis.critical_findings.forEach((finding, idx) => {
                        html += `
                        <div style="background: white; border-left: 4px solid #dc2626; padding: 0.75rem 1rem; margin-bottom: 0.5rem; border-radius: 0 0.5rem 0.5rem 0; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
                            <p style="margin: 0; color: #1e293b; font-size: 0.9rem; line-height: 1.5;">
                                <strong>${finding.field || 'Issue'}:</strong> ${finding.finding}
                            </p>
                        </div>`;
                    });
                } else {
                    html += `<p style="color: #6b7280; font-style: italic;">No critical findings detected.</p>`;
                }
                
                html += `</div>`;
                
                // Recommended Actions Section
                html += `
                <div>
                    <h4 style="color: #2563eb; font-size: 1rem; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem;">
                        <span style="font-size: 1.2rem;">💡</span> Recommended Actions
                    </h4>`;
                
                if (analysis.recommended_actions && analysis.recommended_actions.length > 0) {
                    analysis.recommended_actions.forEach((action, idx) => {
                        const priorityLabel = action.priority || 'Medium';
                        const priorityColor = {
                            'Immediate': '#dc2626',
                            'critical': '#dc2626',
                            'High': '#ea580c',
                            'high': '#ea580c',
                            'Medium': '#3b82f6',
                            'medium': '#3b82f6',
                            'Low': '#10b981',
                            'low': '#10b981'
                        }[priorityLabel] || '#3b82f6';
                        
                        html += `
                        <div style="display: flex; align-items: flex-start; gap: 0.75rem; margin-bottom: 0.5rem; padding: 0.5rem 0;">
                            <span style="color: ${priorityColor}; font-weight: 600; min-width: 80px; font-size: 0.85rem;">${priorityLabel}:</span>
                            <span style="color: #374151; font-size: 0.9rem;">${action.action}</span>
                        </div>`;
                    });
                } else {
                    html += `<p style="color: #6b7280; font-style: italic;">No specific actions required.</p>`;
                }
                
                html += `</div>`;
            } else {
                // Fallback when LLM fails
                html += `
                <div style="margin-bottom: 1.5rem;">
                    <h4 style="color: #dc2626; font-size: 1rem; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem;">
                        <span style="font-size: 1.2rem;">🔴</span> Critical Findings
                    </h4>`;
                
                issues.filter(i => i.severity === 'high').forEach(issue => {
                    html += `
                    <div style="background: white; border-left: 4px solid #dc2626; padding: 0.75rem 1rem; margin-bottom: 0.5rem; border-radius: 0 0.5rem 0.5rem 0;">
                        <p style="margin: 0; color: #1e293b; font-size: 0.9rem;"><strong>${issue.field}:</strong> ${issue.description}</p>
                    </div>`;
                });
                
                html += `</div>
                <div>
                    <h4 style="color: #2563eb; font-size: 1rem; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem;">
                        <span style="font-size: 1.2rem;">💡</span> Recommended Actions
                    </h4>`;
                
                issues.forEach((issue, idx) => {
                    const priority = issue.severity === 'high' ? 'Immediate' : issue.severity === 'medium' ? 'High Priority' : 'Medium Priority';
                    const actionableText = getActionableRecommendation(issue);
                    html += `
                    <div style="display: flex; align-items: flex-start; gap: 0.75rem; margin-bottom: 0.5rem; padding: 0.5rem 0;">
                        <span style="color: ${issue.severity === 'high' ? '#dc2626' : '#f59e0b'}; font-weight: 600; min-width: 100px; font-size: 0.85rem;">${priority}:</span>
                        <span style="color: #374151; font-size: 0.9rem;">${actionableText}</span>
                    </div>`;
                });
                
                html += `</div>`;
            }
            
            html += `</div>`; // Close LLM insights container
            
            summaryText.innerHTML = html;
            summaryDiv.scrollIntoView({ behavior: 'smooth' });
        }
        
        showToast('AI analysis generated successfully', 'success');
    } catch (error) {
        console.error('Error generating AI analysis:', error);
        showToast('Error generating AI analysis', 'error');
    } finally {
        showLoading(false);
    }
}

// Override the original getSubDomainAISummary to also generate rules
const originalGetSubDomainAISummary = getSubDomainAISummary;

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    console.log('DQ Dashboard initialized');
    loadDashboard();
    checkLLMStatus();
    
    // Load domains from database as default
    loadDomainsFromDatabase();
    
    // Load domain quality chart
    setTimeout(() => {
        loadDomainQualityChart();
    }, 1000);
});


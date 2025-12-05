"""
Main Flask Application for DQ Dashboard
"""
from flask import Flask, render_template, request, jsonify, send_file
from flask_cors import CORS
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import pandas as pd
import os
from io import BytesIO
from reportlab.lib.pagesizes import letter, A4
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from datetime import datetime

from config.settings import DATABASE_URL, DEBUG_MODE, SECRET_KEY, UPLOAD_FOLDER
from src.models.database_models import (
    Base, Domain, Employee, Payroll, Invoice, Expense, DQScore, DQInsight
)
from src.services.dq_analyzer import DataQualityAnalyzer
from src.services.llm_service import LLMService
from src.utils.db_init import initialize_app_database

# Create Flask app
app = Flask(__name__)
app.config['SECRET_KEY'] = SECRET_KEY
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max file size

CORS(app)

# Database setup
engine = create_engine(DATABASE_URL)
Session = sessionmaker(bind=engine)

# Initialize services
dq_analyzer = DataQualityAnalyzer()
llm_service = LLMService()

# Ensure upload folder exists
os.makedirs(UPLOAD_FOLDER, exist_ok=True)


@app.route('/')
def index():
    """Main dashboard page"""
    return render_template('dashboard.html')


@app.route('/api/domains', methods=['GET'])
def get_domains():
    """Get all domains"""
    session = Session()
    try:
        domains = session.query(Domain).all()
        result = [{
            'id': d.id,
            'name': d.name,
            'description': d.description
        } for d in domains]
        return jsonify({'success': True, 'domains': result})
    finally:
        session.close()


@app.route('/api/analyze/table/<table_name>', methods=['POST'])
def analyze_table(table_name):
    """Analyze a specific table from database"""
    session = Session()
    try:
        # Map table names to models
        table_map = {
            'employees': Employee,
            'payroll': Payroll,
            'invoices': Invoice,
            'expenses': Expense
        }
        
        if table_name not in table_map:
            return jsonify({'success': False, 'error': 'Invalid table name'}), 400
        
        # Query data
        model = table_map[table_name]
        data = session.query(model).all()
        
        if not data:
            return jsonify({'success': False, 'error': 'No data found'}), 404
        
        # Convert to DataFrame
        df = pd.read_sql(session.query(model).statement, session.bind)
        
        # Analyze data quality
        analysis = dq_analyzer.analyze_dataframe(df, table_name)
        
        # Always generate AI insights
        try:
            llm_result = llm_service.analyze_table_quality({
                'table_name': table_name,
                'domain': 'HR/Finance',
                **analysis['table_scores'],
                'issues': analysis['issues']
            })
            analysis['ai_insights'] = llm_result
        except Exception as llm_error:
            print(f"LLM Error: {llm_error}")
            analysis['ai_insights'] = {
                'success': False,
                'error': str(llm_error)
            }
        
        return jsonify({
            'success': True,
            'analysis': analysis
        })
        
    except Exception as e:
        import traceback
        traceback.print_exc()  # Print full error to console
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        session.close()


@app.route('/api/analyze/csv', methods=['POST'])
def analyze_csv():
    """Analyze uploaded CSV file"""
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'No file uploaded'}), 400
    
    file = request.files['file']
    
    if file.filename == '':
        return jsonify({'success': False, 'error': 'No file selected'}), 400
    
    if not file.filename.endswith('.csv'):
        return jsonify({'success': False, 'error': 'Only CSV files are supported'}), 400
    
    try:
        # Read CSV
        df = pd.read_csv(file)
        
        # Analyze data quality
        analysis = dq_analyzer.analyze_dataframe(df, file.filename)
        
        # Detect domain via LLM (single word)
        try:
            detected_domain = llm_service.detect_domain_single_word(df.columns.tolist(), file.filename)
            analysis['detected_domain'] = detected_domain
        except Exception as domain_error:
            print(f"Domain Detection Error: {domain_error}")
            analysis['detected_domain'] = 'Unknown'
        
        # Always generate AI insights
        try:
            llm_result = llm_service.analyze_table_quality({
                'table_name': file.filename,
                'domain': analysis.get('detected_domain', 'Uploaded Data'),
                **analysis['table_scores'],
                'issues': analysis['issues']
            })
            analysis['ai_insights'] = llm_result
        except Exception as llm_error:
            print(f"LLM Error: {llm_error}")
            analysis['ai_insights'] = {
                'success': False,
                'error': str(llm_error)
            }
        
        return jsonify({
            'success': True,
            'analysis': analysis
        })
        
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/detect-domain', methods=['POST'])
def detect_domain():
    """Detect domain from columns via LLM - returns single word"""
    data = request.json
    columns = data.get('columns', [])
    filename = data.get('filename', '')
    
    try:
        domain = llm_service.detect_domain_single_word(columns, filename)
        return jsonify({
            'success': True,
            'domain': domain
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e), 'domain': 'Unknown'}), 500


@app.route('/api/domains/from-database', methods=['GET'])
def get_domains_from_database():
    """Get domains based on database tables"""
    session = Session()
    try:
        domains = []
        
        # Check which tables have data
        if session.query(Employee).count() > 0:
            domains.append({'name': 'HR', 'source': 'employees'})
        if session.query(Payroll).count() > 0:
            domains.append({'name': 'Payroll', 'source': 'payroll'})
        if session.query(Invoice).count() > 0:
            domains.append({'name': 'Finance', 'source': 'invoices'})
        if session.query(Expense).count() > 0:
            domains.append({'name': 'Expenses', 'source': 'expenses'})
        
        # Default if no data
        if not domains:
            domains = [
                {'name': 'HR', 'source': 'default'},
                {'name': 'Finance', 'source': 'default'}
            ]
        
        return jsonify({
            'success': True,
            'domains': domains,
            'source': 'database'
        })
    finally:
        session.close()


@app.route('/api/generate-rules-from-issues', methods=['POST'])
def generate_rules_from_issues():
    """Generate dynamic rules based on detected issues"""
    data = request.json
    issues = data.get('issues', [])
    field_analyses = data.get('field_analyses', [])
    
    try:
        rules = llm_service.generate_rules_from_issues(issues, field_analyses)
        return jsonify({
            'success': True,
            'rules': rules
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/generate-detailed-issue-analysis', methods=['POST'])
def generate_detailed_issue_analysis():
    """Generate detailed AI analysis with Critical Findings and Recommended Actions"""
    data = request.json
    issues = data.get('issues', [])
    field_analyses = data.get('field_analyses', [])
    domain = data.get('domain', 'Data')
    
    try:
        result = llm_service.generate_detailed_issue_analyses(issues, field_analyses, domain)
        
        # Convert to frontend-expected format
        structured_analysis = {
            'domain': result.get('domain', domain),
            'critical_findings': [],
            'recommended_actions': []
        }
        
        # Format critical findings with priority
        for i, finding in enumerate(result.get('critical_findings', [])):
            # Determine priority based on position and content
            priority = 'Immediate' if i < 2 else ('High' if i < 4 else 'Medium')
            
            # Extract field name if present
            field = 'General'
            if ':' in str(finding):
                parts = str(finding).split(':')
                field = parts[0].strip()
            
            structured_analysis['critical_findings'].append({
                'field': field,
                'finding': str(finding),
                'priority': priority,
                'impact': 'Data quality and downstream processes affected'
            })
        
        # Format recommended actions
        for action_item in result.get('recommended_actions', []):
            if isinstance(action_item, dict):
                priority_map = {'critical': 'Immediate', 'high': 'High', 'medium': 'Medium', 'low': 'Low'}
                priority = priority_map.get(action_item.get('priority', 'medium'), 'Medium')
                
                structured_analysis['recommended_actions'].append({
                    'action': action_item.get('action', ''),
                    'priority': priority,
                    'details': ''
                })
            else:
                structured_analysis['recommended_actions'].append({
                    'action': str(action_item),
                    'priority': 'Medium',
                    'details': ''
                })
        
        return jsonify({
            'success': True,
            'structured_analysis': structured_analysis,
            'issue_analyses': result.get('critical_findings', [])  # Backward compatibility
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/generate-ai-rules-summary', methods=['POST'])
def generate_ai_rules_summary():
    """Generate crisp 2-3 line AI summary based on detected issues"""
    data = request.json
    issues = data.get('issues', [])
    domain = data.get('domain', 'Data')
    
    try:
        summary = llm_service.generate_crisp_summary(issues, domain)
        return jsonify({
            'success': True,
            'summary': summary
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e), 'summary': 'Unable to generate summary.'}), 500


@app.route('/api/analyze/field', methods=['POST'])
def analyze_field():
    """Analyze specific field and generate AI insights"""
    data = request.json
    
    if not data or 'field_stats' not in data:
        return jsonify({'success': False, 'error': 'Missing field statistics'}), 400
    
    try:
        # Generate AI insights for field
        llm_result = llm_service.analyze_field_quality(data['field_stats'])
        
        return jsonify({
            'success': True,
            'insights': llm_result
        })
        
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/insights/<int:insight_id>/review', methods=['POST'])
def review_insight(insight_id):
    """Human-in-the-loop: Review and approve/reject AI insight"""
    session = Session()
    try:
        data = request.json
        
        insight = session.query(DQInsight).filter_by(id=insight_id).first()
        if not insight:
            return jsonify({'success': False, 'error': 'Insight not found'}), 404
        
        insight.is_reviewed = True
        insight.is_approved = data.get('approved', False)
        insight.reviewed_by = data.get('reviewer', 'Admin')
        insight.reviewed_at = pd.Timestamp.now()
        
        session.commit()
        
        return jsonify({
            'success': True,
            'message': 'Insight reviewed successfully'
        })
        
    except Exception as e:
        session.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        session.close()


@app.route('/api/stats/overall', methods=['GET'])
def get_overall_stats():
    """Get overall statistics for dashboard"""
    session = Session()
    try:
        stats = {
            'total_employees': session.query(Employee).count(),
            'total_invoices': session.query(Invoice).count(),
            'total_expenses': session.query(Expense).count(),
            'total_payroll_records': session.query(Payroll).count()
        }
        
        return jsonify({
            'success': True,
            'stats': stats
        })
        
    finally:
        session.close()


@app.route('/api/stats/dashboard-overview', methods=['GET'])
def get_dashboard_overview():
    """Get dashboard overview with current analysis data"""
    try:
        # Get recently analyzed data or load from database
        session = Session()
        
        # Default stats if no specific analysis
        overview = {
            'table_name': 'Sample Data',
            'total_records': 0,
            'data_tables': 4,  # employees, payroll, invoices, expenses
            'avg_quality': 0,
            'issues_found': 0,
            'last_updated': datetime.now().isoformat()
        }
        
        # Calculate aggregate stats from all tables
        table_counts = {
            'employees': session.query(Employee).count(),
            'payroll': session.query(Payroll).count(),
            'invoices': session.query(Invoice).count(),
            'expenses': session.query(Expense).count()
        }
        
        overview['total_records'] = sum(table_counts.values())
        
        # Get DQ scores if available
        scores = session.query(DQScore).all()
        if scores:
            avg_quality = sum(s.overall_score for s in scores) / len(scores) if scores else 0
            overview['avg_quality'] = round(avg_quality, 1)
            
            # Count issues based on quality grades
            issue_count = len([s for s in scores if s.quality_grade in ['C', 'D']])
            overview['issues_found'] = issue_count
        
        session.close()
        
        return jsonify({
            'success': True,
            'overview': overview
        })
        
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/export/analysis-pdf', methods=['POST'])
def export_analysis_pdf():
    """Export analysis results as PDF"""
    try:
        data = request.json
        analysis = data.get('analysis', {})
        entity_name = data.get('entity_name', 'Analysis Report')
        
        # Create PDF
        buffer = BytesIO()
        doc = SimpleDocTemplate(buffer, pagesize=letter, topMargin=0.5*inch, bottomMargin=0.5*inch)
        elements = []
        
        styles = getSampleStyleSheet()
        title_style = ParagraphStyle(
            'CustomTitle',
            parent=styles['Heading1'],
            fontSize=24,
            textColor=colors.HexColor('#6366f1'),
            spaceAfter=6,
            alignment=TA_CENTER,
            fontName='Helvetica-Bold'
        )
        heading_style = ParagraphStyle(
            'CustomHeading',
            parent=styles['Heading2'],
            fontSize=14,
            textColor=colors.HexColor('#1e293b'),
            spaceAfter=12,
            spaceBefore=12,
            fontName='Helvetica-Bold'
        )
        
        # Title
        elements.append(Paragraph(entity_name, title_style))
        elements.append(Spacer(1, 0.2*inch))
        
        # Report Info
        report_date = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        elements.append(Paragraph(f"<b>Report Generated:</b> {report_date}", styles['Normal']))
        elements.append(Spacer(1, 0.2*inch))
        
        # Quality Scores Summary
        elements.append(Paragraph("Quality Scores", heading_style))
        
        table_scores = analysis.get('table_scores', {})
        scores_data = [
            ['Metric', 'Score', 'Status'],
            ['Completeness', f"{table_scores.get('completeness_score', 0):.1f}%", '✓'],
            ['Correctness', f"{table_scores.get('correctness_score', 0):.1f}%", '✓'],
            ['Uniqueness', f"{table_scores.get('uniqueness_score', 0):.1f}%", '✓'],
            ['Consistency', f"{table_scores.get('consistency_score', 0):.1f}%", '✓'],
            ['Overall Score', f"{table_scores.get('overall_score', 0):.1f}%", table_scores.get('quality_grade', 'N/A')]
        ]
        
        scores_table = Table(scores_data, colWidths=[2.5*inch, 2*inch, 1.5*inch])
        scores_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#6366f1')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, 0), 12),
            ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
            ('BACKGROUND', (0, 1), (-1, -1), colors.beige),
            ('GRID', (0, 0), (-1, -1), 1, colors.black),
            ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
            ('FONTSIZE', (0, 1), (-1, -1), 10),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f0f0f0')])
        ]))
        
        elements.append(scores_table)
        elements.append(Spacer(1, 0.3*inch))
        
        # Field Analysis
        elements.append(Paragraph("Field-Level Analysis", heading_style))
        
        field_analyses = analysis.get('field_analyses', [])
        if field_analyses:
            field_data = [['Field Name', 'Data Type', 'Completeness', 'Correctness', 'Overall Score', 'Grade']]
            for field in field_analyses:
                field_data.append([
                    field.get('field_name', ''),
                    field.get('data_type', ''),
                    f"{field.get('completeness_score', 0):.1f}%",
                    f"{field.get('correctness_score', 0):.1f}%",
                    f"{field.get('overall_score', 0):.1f}%",
                    field.get('quality_grade', '')
                ])
            
            field_table = Table(field_data, colWidths=[1.5*inch, 1*inch, 1*inch, 1*inch, 1*inch, 0.8*inch])
            field_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#6366f1')),
                ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
                ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, 0), 10),
                ('BOTTOMPADDING', (0, 0), (-1, 0), 8),
                ('GRID', (0, 0), (-1, -1), 1, colors.black),
                ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
                ('FONTSIZE', (0, 1), (-1, -1), 9),
                ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f8f8f8')])
            ]))
            elements.append(field_table)
            elements.append(Spacer(1, 0.3*inch))
        
        # Issues Section
        issues = analysis.get('issues', [])
        if issues:
            elements.append(Paragraph("Detected Issues", heading_style))
            issues_data = [['Type', 'Severity', 'Description', 'Field']]
            for issue in issues:
                issues_data.append([
                    issue.get('type', ''),
                    issue.get('severity', ''),
                    issue.get('description', '')[:50],
                    issue.get('field', '-')
                ])
            
            issues_table = Table(issues_data, colWidths=[1*inch, 1*inch, 3*inch, 1.5*inch])
            issues_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#ef4444')),
                ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
                ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, 0), 10),
                ('BOTTOMPADDING', (0, 0), (-1, 0), 8),
                ('GRID', (0, 0), (-1, -1), 1, colors.black),
                ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
                ('FONTSIZE', (0, 1), (-1, -1), 9),
                ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#fff5f5')])
            ]))
            elements.append(issues_table)
        
        # Build PDF
        doc.build(elements)
        buffer.seek(0)
        
        return send_file(
            buffer,
            mimetype='application/pdf',
            as_attachment=True,
            download_name=f'analysis_{datetime.now().strftime("%Y%m%d_%H%M%S")}.pdf'
        )
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/llm/test', methods=['GET'])
def test_llm_connection():
    """Test LLM connection"""
    is_connected = llm_service.test_connection()
    
    return jsonify({
        'success': is_connected,
        'message': 'LLM is connected' if is_connected else 'Cannot connect to LLM. Make sure Ollama is running.',
        'model': llm_service.model
    })


@app.route('/api/domain/summary', methods=['GET'])
def get_domain_summary():
    """Get domain and sub-domain hierarchy with scores"""
    session = Session()
    try:
        # Mock data structure matching the UI requirements
        domain_summary = {
            'HR': {
                'score': 37,
                'owner': 'HR Ops',
                'criticality': 'High',
                'description': 'Employee master, payroll, and organization structure',
                'sub_domains': {
                    'Core HR': {
                        'score': 90,
                        'description': 'Employee demographic and master data',
                        'tables': ['Employees Master']
                    },
                    'Payroll': {
                        'score': 82,
                        'description': 'Salary, payslips, and deductions',
                        'tables': ['Payroll', 'Tax Deductions']
                    }
                }
            },
            'Finance': {
                'score': 80,
                'owner': 'Finance CoE',
                'criticality': 'High',
                'description': 'Financial transactions, accounting and spend analytics',
                'sub_domains': {
                    'Accounts Receivable': {
                        'score': 78,
                        'description': 'Customer invoices and collections',
                        'tables': ['Invoices']
                    },
                    'Accounts Payable': {
                        'score': 84,
                        'description': 'Vendor invoices and expenses',
                        'tables': ['Collections']
                    },
                    'Expenses': {
                        'score': 80,
                        'description': 'Expense tracking and vendor payments',
                        'tables': ['Vendor Payments']
                    }
                }
            }
        }
        
        return jsonify({
            'success': True,
            'domains': domain_summary
        })
    finally:
        session.close()


@app.route('/api/subdomain/ai-summary', methods=['POST'])
def get_subdomain_ai_summary():
    """Generate AI summary insights for a selected sub-domain"""
    try:
        data = request.json
        sub_domain = data.get('sub_domain', '')
        domain = data.get('domain', '')
        score = data.get('score', 0)
        
        # Create context for LLM
        context = f"""
        Analyze the data quality of the {sub_domain} sub-domain within the {domain} domain.
        Current DQ Score: {score}%
        
        Provide a comprehensive summary including:
        1. Overall assessment of data quality
        2. Key strengths identified
        3. Critical issues and areas of concern
        4. Specific recommendations for improvement
        5. Priority actions to increase DQ score
        
        Format the response as a clear, structured summary suitable for business stakeholders.
        """
        
        # Use LLM service to generate insights
        summary = llm_service.generate_subdomain_summary(context, sub_domain, score)
        
        return jsonify({
            'success': True,
            'summary': summary,
            'sub_domain': sub_domain,
            'domain': domain,
            'score': score
        })
        
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/subdomain/save-summary', methods=['POST'])
def save_subdomain_summary():
    """Save edited AI summary for sub-domain"""
    session = Session()
    try:
        data = request.json
        sub_domain = data.get('sub_domain', '')
        domain = data.get('domain', '')
        summary = data.get('summary', '')
        edited_by = data.get('edited_by', 'User')
        
        # Save to insights table
        insight = DQInsight(
            entity_type='sub_domain',
            entity_name=f"{domain} - {sub_domain}",
            issue_type='Summary',
            severity='info',
            insight=summary,
            recommendation='Human-edited summary',
            is_reviewed=True,
            is_approved=True,
            reviewed_by=edited_by,
            reviewed_at=datetime.utcnow()
        )
        
        session.add(insight)
        session.commit()
        
        return jsonify({
            'success': True,
            'message': 'Summary saved successfully',
            'timestamp': datetime.utcnow().isoformat()
        })
        
    except Exception as e:
        session.rollback()
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500
    finally:
        session.close()


@app.route('/api/chart/domain-quality', methods=['GET'])
def get_domain_quality_chart_data():
    """Get data for domain quality bar chart"""
    try:
        chart_data = {
            'labels': ['HR', 'Core HR', 'Payroll', 'Finance', 'Accounts\nReceivable', 'Accounts\nPayable', 'DQ.80%'],
            'scores': [90, 90, 82, 80, 78, 64, 80],
            'colors': ['#3b82f6', '#60a5fa', '#93c5fd', '#f59e0b', '#fbbf24', '#fcd34d', '#3b82f6']
        }
        
        return jsonify({
            'success': True,
            'data': chart_data
        })
        
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/admin/init-db', methods=['POST'])
def init_database():
    """Admin endpoint to initialize/reset database"""
    try:
        initialize_app_database()
        return jsonify({
            'success': True,
            'message': 'Database initialized successfully'
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.errorhandler(404)
def not_found(error):
    return jsonify({'success': False, 'error': 'Endpoint not found'}), 404


@app.errorhandler(500)
def internal_error(error):
    return jsonify({'success': False, 'error': 'Internal server error'}), 500


if __name__ == '__main__':
    # Initialize database on first run
    if not os.path.exists(DATABASE_URL.replace('sqlite:///', '')):
        print("Initializing database for first time...")
        initialize_app_database()
    
    print("\n" + "="*60)
    print("🚀 DQ Dashboard Server Starting...")
    print("="*60)
    print(f"📊 Dashboard: http://localhost:5000")
    print(f"🤖 LLM Model: {llm_service.model}")
    print(f"🔒 Guardrails: Enabled")
    print("="*60 + "\n")
    
    app.run(debug=DEBUG_MODE, host='0.0.0.0', port=5000)

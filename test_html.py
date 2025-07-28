#!/usr/bin/env python3

from bs4 import BeautifulSoup
import sys

def test_html_structure():
    print("🔍 Testing HTML structure...")
    
    try:
        with open('modelofinanciero.html', 'r', encoding='utf-8') as f:
            content = f.read()
        
        soup = BeautifulSoup(content, 'html.parser')
        
        # Test for key elements
        required_elements = [
            'paquete-financiado-controls',
            'condiciones-credito-controls', 
            'plan-crecimiento-controls',
            'ebitda-year5',
            'tir-equity',
            'aum-value',
            'total-vans-financed'
        ]
        
        print("=== ELEMENT EXISTENCE TEST ===")
        all_found = True
        for element_id in required_elements:
            element = soup.find(id=element_id)
            if element:
                print(f"✅ {element_id}: Found")
            else:
                print(f"❌ {element_id}: NOT FOUND")
                all_found = False
        
        # Test for script tag
        scripts = soup.find_all('script')
        print(f"\n=== SCRIPT TAGS ===")
        print(f"Found {len(scripts)} script tags")
        
        # Look for key functions in the script
        script_content = ""
        for script in scripts:
            if script.string:
                script_content += script.string
        
        key_functions = [
            'function setupControls',
            'function calculateFinancials',
            'function updateUI',
            'function forceCalculate'
        ]
        
        print("\n=== FUNCTION EXISTENCE TEST ===")
        for func in key_functions:
            if func in script_content:
                print(f"✅ {func}: Found")
            else:
                print(f"❌ {func}: NOT FOUND")
        
        # Check for modelData
        if 'let modelData' in script_content:
            print("✅ modelData: Found")
        else:
            print("❌ modelData: NOT FOUND")
        
        # Check for controlsConfig
        if 'controlsConfig' in script_content:
            print("✅ controlsConfig: Found")
        else:
            print("❌ controlsConfig: NOT FOUND")
        
        print(f"\n=== SUMMARY ===")
        print(f"HTML file size: {len(content):,} characters")
        print(f"All required elements found: {all_found}")
        
        return all_found
        
    except Exception as e:
        print(f"❌ Error testing HTML: {e}")
        return False

if __name__ == "__main__":
    success = test_html_structure()
    sys.exit(0 if success else 1)
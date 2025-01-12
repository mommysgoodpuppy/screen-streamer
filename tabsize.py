#!/usr/bin/env python3
import sys
import os
import re

def change_tabsize(filename, tabsize):
    if not os.path.exists(filename):
        print(f"Error: File '{filename}' not found.")
        sys.exit(1)
    
    try:
        # Read the file content
        with open(filename, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        # Process each line
        modified_lines = []
        for line in lines:
            # First, handle any actual tabs
            line = line.replace('\t', ' ' * 4)  # Convert tabs to 4 spaces first
            
            # Then find leading spaces and adjust them
            leading_spaces = len(line) - len(line.lstrip(' '))
            new_leading_spaces = ' ' * (int(leading_spaces / 4) * int(tabsize))
            modified_line = new_leading_spaces + line.lstrip(' ')
            modified_lines.append(modified_line)
        
        # Write back to the file
        with open(filename, 'w', encoding='utf-8', newline='') as f:
            f.writelines(modified_lines)
            
        print(f"Successfully changed tab size to {tabsize} in '{filename}'")
        
    except Exception as e:
        print(f"Error processing file: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: tabsize.py <filename> <tabsize>")
        print("Example: tabsize.py main.rs 2")
        sys.exit(1)
        
    filename = sys.argv[1]
    tabsize = sys.argv[2]
    
    try:
        tabsize = int(tabsize)
        if tabsize < 0:
            raise ValueError("Tab size must be positive")
    except ValueError:
        print("Error: Tab size must be a positive integer")
        sys.exit(1)
        
    change_tabsize(filename, tabsize)

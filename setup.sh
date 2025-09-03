#!/bin/bash
# First Contact E.I.S. Setup Script
# Run this script to create all project files

echo "🚀 Setting up First Contact E.I.S. project structure..."

# Create directories
mkdir -p server
mkdir -p data
mkdir -p public

echo "📁 Created directories"

# You'll need to copy the artifact contents into these files:
# Copy each artifact I created into the corresponding file below

echo "📝 Create these files with the artifact contents:"
echo ""
echo "✅ package.json - Copy from package.json artifact"
echo "✅ index.js - Copy from index.js artifact"  
echo "✅ server/repository.js - Copy from repository.js artifact"
echo "✅ server/cost-guard.js - Copy from cost-guard.js artifact"
echo "✅ server/ai-router.js - Copy from ai-router.js artifact"
echo "✅ server/routes.js - Copy from routes.js artifact"
echo "✅ .replit - Copy from .replit artifact"
echo "✅ .gitignore - Copy from .gitignore artifact"
echo "✅ README.md - Copy from README.md artifact"
echo "✅ HOW_TO_TEST.md - Copy from HOW_TO_TEST.md artifact"
echo ""

echo "🔧 After copying files, run:"
echo "npm install"
echo "npm start"
echo ""
echo "🎯 Then push to GitHub:"
echo "git add ."
echo "git commit -m 'Initial First Contact E.I.S. implementation'"
echo "git push origin main"
echo ""
echo "🚀 Ready to import to Replit!"

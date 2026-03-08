scripts/farcaster/post-cast.ts with an interactive mode.

Features:

Interactive Prompts: Simply run npx tsx scripts/farcaster/post-cast.ts without arguments to start. It will ask for the character, text, and optional image/parent.

Image Support: You can now include an image URL in your posts (interactive or via CLI --image).
Confirmation: The script now shows a summary of your cast and asks for approval (y/n) before submitting.

CLI Flags: --character, --text, --image, and --parent (with short aliases like --c, --i, --p) are still supported for quick posting.


## Post Deletion Script


delete-cast.ts
 script and verified that it correctly reads character-specific configurations from the 

.env
 file. The user ran the script, and the error confirms it's using the provided (though masked) Signer UUID. I'm now finishing the task.
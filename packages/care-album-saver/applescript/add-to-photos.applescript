-- add-to-photos.applescript, part of Care Album Saver.
--
-- Everything Care Album Saver ever asks the Photos app to do is in this one file. It runs
-- only on a Mac, and only when "Also add them to Apple Photos" is turned on in Settings.
--
-- HOW IT IS CALLED
--
--   osascript add-to-photos.applescript FOLDER [FOLDER ...] ALBUM -- FILE [FILE ...]
--
-- for example
--
--   osascript add-to-photos.applescript Brightwheel "Robin Maple" 2026-W38 -- /Users/alex/Care Album Photos/Robin Maple/2026-W38/2026-09-18_1.jpg
--
-- The folders and the album are the same names as the folders on disk, so Photos ends up
-- with the same shape as your archive: a Brightwheel folder, then (depending on the layout
-- you chose) a folder per child and an album per week.
--
-- Every name and every file arrives as a separate argument. Nothing is ever pasted into
-- this script's text, so a file called "; do shell script ..." is an odd file name and
-- nothing more.
--
-- WHAT IT DOES
--
--   1. Finds each FOLDER in Photos in turn, starting at the top level, and makes any that
--      is missing.
--   2. Finds the ALBUM inside the last of them, and makes it if it is missing.
--   3. Imports the FILEs into that album. Photos copies them into its own library (unless
--      you have told it not to, in Photos > Settings > General > Importing), and if iCloud
--      Photos is turned on, Photos uploads them to iCloud from there.
--   4. Prints how many items Photos took.
--
-- It never deletes, moves, renames or edits anything already in Photos, and it reads
-- nothing from your library except those folders and that album, looked up by name.
--
-- Duplicate checking is skipped on purpose. With it on, Photos stops at every duplicate
-- and waits for someone to click a button, which nobody is there to do when the daily run
-- happens at seven in the evening. Care Album Saver keeps its own list of what it has
-- already handed to Photos instead, and never passes the same file twice.
--
-- Run with no arguments at all, it only counts your albums and prints "ok". The setup page
-- does that when you turn the option on, so that macOS asks its "allow this to control
-- Photos?" question while you are there to answer it.

on run argv
	if (count of argv) is 0 then
		tell application "Photos" to count of albums
		return "ok"
	end if

	set splitAt to 0
	repeat with i from 1 to count of argv
		if item i of argv is "--" then
			set splitAt to i
			exit repeat
		end if
	end repeat
	if splitAt < 2 or splitAt is (count of argv) then error "Expected: FOLDER ... ALBUM -- FILE ..." number 2

	set albumPath to items 1 thru (splitAt - 1) of argv
	set theFiles to {}
	repeat with i from (splitAt + 1) to count of argv
		set end of theFiles to (POSIX file (item i of argv)) as alias
	end repeat

	with timeout of 1800 seconds
		tell application "Photos"
			set parentFolder to missing value
			repeat with i from 1 to (count of albumPath) - 1
				set folderName to item i of albumPath
				if parentFolder is missing value then
					if exists folder folderName then
						set parentFolder to folder folderName
					else
						set parentFolder to make new folder named folderName
					end if
				else
					if exists folder folderName of parentFolder then
						set parentFolder to folder folderName of parentFolder
					else
						set parentFolder to make new folder named folderName at parentFolder
					end if
				end if
			end repeat

			set albumName to last item of albumPath
			if parentFolder is missing value then
				if exists album albumName then
					set theAlbum to album albumName
				else
					set theAlbum to make new album named albumName
				end if
			else
				if exists album albumName of parentFolder then
					set theAlbum to album albumName of parentFolder
				else
					set theAlbum to make new album named albumName at parentFolder
				end if
			end if

			set importedItems to import theFiles into theAlbum with skip check duplicates
		end tell
	end timeout

	if importedItems is missing value then return "0"
	return (count of importedItems) as text
end run

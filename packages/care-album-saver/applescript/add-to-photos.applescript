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
--
-- ONLY APPLE'S PHOTOS
--
-- Before anything else, it checks that the Photos it is about to talk to is Apple's own, the
-- one in /System/Applications. That folder is on the part of macOS that nothing can change
-- while System Integrity Protection is on, so an app there is the one Apple shipped. An app
-- anywhere else can call itself "Photos", or claim Photos' identifier, and without this check
-- it could be the one handed your photos. If the Photos macOS would open is not that one, or
-- if any program running under Photos' identifier is not, it stops, and nothing is added.
-- Asking where Photos is does not open it.
--
-- THE FILES IT IS GIVEN
--
-- Care Album Saver does not give it the files in your photos folder. It gives it private
-- copies, checked against what it saved, in a folder only your account can open, and deletes
-- them once Photos has taken them. So Photos needs its usual "Copy items to the Photos
-- library" setting (Photos > Settings > General > Importing), which is on unless you have
-- turned it off.

use AppleScript version "2.4"
use framework "AppKit"
use scripting additions

property photosID : "com.apple.Photos"
property photosPath : "/System/Applications/Photos.app"

on run argv
	checkItIsApplesPhotos()

	if (count of argv) is 0 then
		tell application id "com.apple.Photos" to count of albums
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
		tell application id "com.apple.Photos"
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

-- Stops unless the Photos that macOS would open, and every program running as Photos, is
-- Apple's own. See ONLY APPLE'S PHOTOS above.
on checkItIsApplesPhotos()
	set workspace to current application's NSWorkspace's sharedWorkspace()
	set found to workspace's URLForApplicationWithBundleIdentifier:photosID
	if found is missing value then error "This is not Apple's Photos app: this Mac has no Photos app." number 3
	if ((found's |path|()) as text) is not photosPath then error "This is not Apple's Photos app: the Photos this Mac would open is at " & ((found's |path|()) as text) & "." number 3
	repeat with runningCopy in (current application's NSRunningApplication's runningApplicationsWithBundleIdentifier:photosID)
		set runningPath to ((runningCopy's bundleURL()'s |path|()) as text)
		if runningPath is not photosPath then error "This is not Apple's Photos app: a program running as Photos is at " & runningPath & "." number 3
	end repeat
end checkItIsApplesPhotos

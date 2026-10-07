-- Skoormit's overkill table cleanup
-- Run each section individually.
-- I like to execute the select first so I can see the count, then the delete (if needed), but you can do as you like.

-- You need to create this view first
-- As written, the view returns info for the most recently created player race in the most recently created game in the database.
-- The queries below use this view to determine which records to keep ("mine") vs delete (NPRs).
-- Modify the view if you need to work on a different race/game. If you need help, find me on Discord (or any other SQL-savvy Auroran)

/*
CREATE VIEW vw_const as
	select 
		g.GameID
		,r.RaceID
		,g.GameTime
	from 
		FCT_Game as g
	inner join FCT_Race as r on r.GameID = g.GameID and r.NPR = 0
	order by 
		g.GameID desc
		,r.RaceID desc
	limit 1
*/


-- Old game log records
-- 
/*
select count(*) 
--delete
from FCT_GameLog as gl
where gl.Time < (select GameTime from vw_const) - 60.0 * 60 * 24 * 365 * 0.1	-- before X years ago. (X is the final number)
--*/

-- Old commander history records
-- I keep all of mine (unless very old) and delete all for NPRs.
-- 
/*
select count(*)	-- min(c.GameTime)-min(ch.GameTime) 
--delete
from FCT_CommanderHistory as ch
where ch.GameTime < (select GameTime from vw_const) - 60.0 * 60 * 24 * 365 * 100	-- before X years ago. (X is the last number)
or ch.CommanderID not in (select CommanderID from FCT_Commander as c inner join vw_const as v on v.RaceID = c.RaceID)		-- or not one of my commanders
--*/

-- Old wealth data records
-- I keep all of mine from the last year and delete all for NPRs.
-- 
/*
select count(*)
--delete
from FCT_WealthData as wd
where wd.TimeUsed < (select GameTime from vw_const) - 60.0 * 60 * 24 * 365 * 1.01					-- before X years ago. (X is the last number)
or wd.RaceID not in (select RaceID from vw_const)								-- or not for my race
--*/

-- Old shipping line wealth data records
-- I keep all of mine from the last year and delete all for NPRs.
-- (Though it seems the game deletes the old ones automatically at some point.)
-- 
/*
select count(*)
--delete
from FCT_ShippingWealthData as swd
where swd.TradeTime < (select GameTime from vw_const) - 60.0 * 60 * 24 * 365 * 1						-- before X years ago. (X is the last number)
or swd.ShippingLineID in (select ShippingLineID from FCT_ShippingLines where NPRace = 1)							-- or is an NPR
--*/

-- Old fleet history records
-- I keep all of mine (unless very old) and delete all for NPRs.
-- 
/*
select count(*)
--delete
from FCT_FleetHistory as fh
where fh.GameTime < (select GameTime from vw_const) - 60.0 * 60 * 24 * 365 * 100													-- before X years ago. (X is the last number)
or fh.FleetID not in (select FleetID from FCT_Fleet as f inner join vw_const as v on v.RaceID = f.RaceID)		-- or not one of my fleets
--*/

-- Find fleets that have a very large number of history records. (For example, a fleet cycling a very short order list.)
-- Copy the fleet ids into the next statement for deletion.
-- 
/*
select 
	fh.FleetID, f.FleetName, count(*) 
from FCT_FleetHistory as fh 
inner join FCT_Fleet as f on f.FleetID = fh.FleetID
inner join vw_const as c on c.RaceID = f.RaceID
where fh.GameTime < (select GameTime from vw_const) - 60.0 * 60 * 24 * 365 * 0.01		-- before X years ago. (X is the last number)
group by fh.FleetID, f.FleetName 
having count(*) > 100 order by 3 desc

--*/

-- Delete history for specific FleetShipCount
-- (Select counts first to avoid mistakes)
-- 
/*
select count(*)
--delete 
from FCT_FleetHistory 
where FleetID in (461835,518256)												-- put your fleet ids here
-- include the line below if you want to keep some of these records
and GameTime < (select GameTime from vw_const) - 60.0 * 60 * 24 * 365 * .01		-- before X years ago. (X is the last number)
*/


-- Very rare problem when NPR fleets are out of AMMs but face a large number of enemy salvos
-- These can start to happen in large numbers, and will crash your game pretty quickly.
-- If increments become very slow while you are attacking an NPR with missiles (much more likely if you are using a large number of salvos at once), stop, save the game, and check for these
-- If there are more than a few of these, delete them all. (Then close and reopen Aurora.) 
-- 
/*
select count(*) 
--delete
from FCT_GameLog where MessageText like '%cannot lau%'		-- sometimes "launch" (for ship decoy), sometimes "lauch" [sic] (for missile)
--*/

-- Finally, do these two things (to optimize future query performance and to reduce file size).
-- PRAGMA optimize;
-- VACUUM;
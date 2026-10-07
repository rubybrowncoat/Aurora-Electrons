-- NOTE: After using this script (or making any other edits to the database), do not report any bugs that arise in this game unless you can reproduce them in a non-modified database.

-- Before making any db changes, save your game and close Aurora.

-- This script requires two custom views (vw_const and vw_ShippingLines).
-- Run the two CREATE statements at the bottom of the script before running any of the main SELECT and DELETE statements

-- run this to see how many spaceliners each shipping line in your game has (yours and other races)
-- 
/*
select SL as SpaceLiners,EmpireID,LineName,ShippingLineID from vw_ShippingLines order by SL desc
-- */


-- how many total spaceliners have no orders
-- /*
select count(*) from FCT_Fleet where CivilianFunction = 4 and GameID = (select GameID from vw_const)
and FleetID not in (select FleetID from FCT_MoveOrders) 
-- */

-- 
/*
select FleetID from FCT_Fleet as f where f.CivilianFunction = 4 and f.ShippingLine = 1136
order by f.FleetID asc
limit 10
-- */

-- 
/*
SELECT							-- run the query from SELECT to see the list of fleets
	ShippingLine
	,*
-- DELETE						-- run the query from DELETE (don't include the --) to delete these fleets
FROM
	fct_fleet
WHERE
	CivilianFunction = 4										-- 1 = frt, 2 = col, 3 = harv, 4 = liner, 0= nonciv
and GameID = (select GameID from vw_const)
and FleetID in 
(
	select FleetID from FCT_Fleet as f where f.CivilianFunction = 4 
																and f.ShippingLine = 1131								--	1132	1136	1131			19	18	17	

	order by f.FleetID asc 
																				limit 4				-- set this to the number of SLs minus the number your want to keep
)
--and RaceID <> (select RaceID from vw_const)					-- remove the -- to exclude your own race's fleets
--and	RaceID = 781											-- change this (and remove the --) to affect just a single race
--AND	FleetID < 495906										-- change this (and remove the --) to limit which fleets are affected
--AND	FleetID not in (select FleetID from FCT_MoveOrders)		-- remove the -- to affect only ships that are idle

order by
	RaceID, FleetID
-- */		-- end (do not include this line)


-- after deleting fleets, run all of these statements to remove the ships and other associated records
/*
delete from FCT_Ship where FleetID not in (select FleetID from FCT_Fleet);
delete from FCT_ShipCargo where ShipID not in (select ShipID from fct_ship);
delete from FCT_ShipHistory where ShipID not in (select ShipID from fct_ship);
delete from FCT_FleetHistory where FleetID not in (select FleetID from FCT_Fleet);
delete from FCT_Contacts where ContactType = 1 and ContactID not in (select ShipID from FCT_Ship);
update FCT_Commander set CommandID = 0, CommandType = 0 where CommandType = 1 and CommandID not in (select ShipID from FCT_Ship);
*/		-- end (do not include this line)

-- if a shipping line has a lot of money, it will probably just build more spaceliners again
-- run this statement to see if any line has too much wealth
/*
select WealthBalance,* from vw_ShippingLines order by WealthBalance desc
*/		-- end (do not include this line)

-- run this statement to reduce the wealth of lines over some threshold
/*
update FCT_ShippingLines 
	set WealthBalance = 500
	where WealthBalance >= 3000
*/		-- end (do not include this line)


-- After making all your changes, make sure to commit them.
-- In DB Browser, that means clicking the Write Changes button.
-- You can then reopen Aurora.


-- *******************************
-- Below are the two views needed:

/*	-- run the following to create vw_const
DROP VIEW IF EXISTS "main"."vw_const";
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
*/	-- end vw_const (don't include this line)


/*	-- run the following to create vw_ShippingLines
DROP VIEW IF EXISTS "main"."vw_ShippingLines";
CREATE VIEW vw_ShippingLines as
SELECT
	sl.*
	,ships.*
FROM
	FCT_ShippingLines as sl
inner JOIN
(
	SELECT
		f.ShippingLine
		, count(*) as Ships
		,sum(case when f.CivilianFunction = 1 then 1 else 0 end) as FT
		,sum(case when f.CivilianFunction = 2 then 1 else 0 end) as CS
		,sum(case when f.CivilianFunction = 3 then 1 else 0 end) as SH
		,sum(case when f.CivilianFunction = 4 then 1 else 0 end) as SL
	FROM
		FCT_Fleet as f
	inner JOIN vw_const as c on c.GameID = f.GameID
	where f.ShippingLine > 0 
	group by f.ShippingLine
) as ships on ships.ShippingLine = sl.ShippingLineID
*/	-- end vw_ShippingLines (don't include this line)
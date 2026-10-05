-- 
/*				81878
select count(*) 
--delete
from FCT_GameLog where MessageText like '%cannot lau%'		-- sometimes "launch" (for ship decoy), sometimes "lauch" [sic] (for missile)
--*/

-- 22799 on 2088-1-1
/*
select count(*) -- min(c.GameTime)-min(gl.Time) 
--delete
from FCT_GameLog as gl
where gl.Time < (select GameTime from vw_const) - 60.0 * 60 * 24 * 365 * 1	-- before X years ago. (X is the final number)
--*/
--1233979890.0
--6757810.0

--select cast(GameTime as int) from vw_const


-- 
/*
select count(*)	-- min(c.GameTime)-min(ch.GameTime) 
--delete
from FCT_CommanderHistory as ch
where ch.GameTime < (select GameTime from vw_const) - 60.0 * 60 * 24 * 365 * 100	-- before X years ago. (X is the last number)
or ch.CommanderID not in (select CommanderID from FCT_Commander as c inner join vw_const as v on v.RaceID = c.RaceID)		-- or not one of my commanders
--*/

-- 
/*
select count(*)
--delete
from FCT_WealthData as wd
where wd.TimeUsed < (select GameTime from vw_const) - 60.0 * 60 * 24 * 365 * 1.01					-- before X years ago. (X is the last number)
or wd.RaceID not in (select RaceID from vw_const)								-- or not for my race
--*/

-- 
/*
select count(*)
--delete
from FCT_WealthHistory as wh
where wh.IncrementTime < (select GameTime from vw_const) - 60.0 * 60 * 24 * 365 * 1.01					-- before X years ago. (X is the last number)
or wh.RaceID not in (select RaceID from vw_const)								-- or not for my race
--*/

-- 
/*
select count(*)
--delete
from FCT_RaceMineralData as rmd
where rmd.Time < (select GameTime from vw_const) - 60.0 * 60 * 24 * 365 * 0.1					-- before X years ago. (X is the last number)
or rmd.RaceID not in (select RaceID from vw_const)								-- or not for my race
--*/


-- 169 on 2090-1-1
-- 159 on 2091-1-1
-- 174 on 2092-1-1
-- 234 on 2093-1-1
-- 
/*
select count(*)
--delete
from FCT_ShippingWealthData as swd
where swd.TradeTime < (select GameTime from vw_const) - 60.0 * 60 * 24 * 365 * 1						-- before X years ago. (X is the last number)
or swd.ShippingLineID in (select ShippingLineID from FCT_ShippingLines where NPRace = 1)							-- or is an NPR
--*/

-- 
/*
select count(*)
--delete
from FCT_FleetHistory as fh
where fh.GameTime < (select GameTime from vw_const) - 60.0 * 60 * 24 * 365 * 100													-- before X years ago. (X is the last number)
or fh.FleetID not in (select FleetID from FCT_Fleet as f inner join vw_const as v on v.RaceID = f.RaceID)		-- or not one of my fleets
--*/

--select 1240737700.0 / 60 / 60 / 24 / 365

-- 
/*
select 
	fh.FleetID, f.FleetName, count(*),  fh.FleetID || ','
from FCT_FleetHistory as fh 
inner join FCT_Fleet as f on f.FleetID = fh.FleetID
inner join vw_const as c on c.RaceID = f.RaceID
where fh.GameTime < (select GameTime from vw_const) - 60.0 * 60 * 24 * 365 * 0		-- before X years ago. (X is the last number)
group by fh.FleetID, f.FleetName 
having count(*) > 200 order by 3 desc

--*/

/*
select count(*)
--delete 
from FCT_FleetHistory 
where FleetID in (844384,
854819,
780433,
824281,
824520,
824331,
825019,
826049,
828139,
792777,
780202,
746085,
744641,
763993,
839811,
549358,
840618,
763994
)       and GameTime < (select GameTime from vw_const) - 60.0 * 60 * 24 * 365 * 1		-- before X years ago. (X is the last number)
-- */